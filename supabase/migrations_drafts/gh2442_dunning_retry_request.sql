-- STATUS (gh-1438, as of 2026-10-07T22:44Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2442_dunning_retry_request (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: payment_failures.retry_requested_at, payment_failures.retry_request_count and public.request_dunning_retry(uuid) absent on production, read-only SELECT 2026-10-07 (gh-2442 SQL-only revision); anon holds UPDATE, TRUNCATE and TRIGGER on public.payment_failures on production, same query
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md (Tier 3B path: review, R-097 notice, recorded apply)
--
-- Migration: gh2442_dunning_retry_request
-- GitHub: #2442 ([MONEY] the contractor "Retry Payment Now" button has never worked).
-- Decision: D-379 (2026-10-07): a contractor may request a retry of the saved payment method after a failed
--           platform-fee charge, at most 3 times per failed payment for the life of that failure, and only until
--           the homeowner notice goes out. Build ruling: option A, #2442 comment 6025103626. Split order: PR #2579
--           comment 6029194857 (SQL only; the page and the retry pass are a later, separate change).
-- Tier: 3B (money-path table; adds a SECURITY DEFINER function and a REVOKE). NOT APPLIED by the authoring session or by CI.
-- Rollback: supabase/migrations_drafts/gh2442_dunning_retry_request_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2442_dunning_retry_request_pre-flight.md
-- Proof (rolled back, is_test rows only): supabase/tests/gh2442_dunning_retry_request_proof.sql
--
-- What it does.
--   1. Adds payment_failures.retry_requested_at (timestamptz, nullable, no default) and
--      payment_failures.retry_request_count (integer, NOT NULL, default 0, CHECK 0..3). Nothing reads them yet
--      except the function below; a retry pass in process-dunning (a separate, later change) will. No page calls
--      the function yet.
--   2. Adds request_dunning_retry(p_failure_id uuid) -> jsonb. SECURITY DEFINER, search_path pinned, no dynamic SQL.
--      The signed-in caller must own the failure through contractors.user_id = auth.uid(); anyone else (another
--      contractor, a homeowner, an unknown id) gets 42501 with the same message, so the function is not an oracle for
--      which ids exist. The ONLY columns it writes are retry_requested_at and retry_request_count. A second call
--      within 15 minutes of the stored request writes nothing and returns the existing request.
--   3. Grants EXECUTE to authenticated only (revoked from PUBLIC and anon). This is a NEW GRANT to `authenticated`:
--      when this file is filed under supabase/migrations/ the "No new GRANT to anon/PUBLIC/authenticated" check
--      (permissions-ratchet) needs the PR label `permissions-ratchet: reviewed`.
--   4. Revokes anon UPDATE, TRUNCATE and TRIGGER on payment_failures. RLS already blocked anon rows; the grants were
--      only a missing second lock. anon SELECT and REFERENCES are left as they are (no anon policy exists, so SELECT
--      returns nothing); they are not writes. The rollback file does NOT give these three back.
--      NOT IN THIS FILE, on purpose: `authenticated` also holds INSERT, UPDATE, DELETE and TRUNCATE on this table,
--      and row security does not govern TRUNCATE. That revoke is a separate protective change (named by the CEO in
--      PR #2579 comment 6045861846) and is not made here.
--
-- THE CAP (D-379: up to 3 per failed payment). Held in two places:
--   - the function: c_max_requests = 3, tested and incremented under the row lock;
--   - the table: CHECK (retry_request_count BETWEEN 0 AND 3), so no writer of any role, including a service-role
--     job, can store a count outside 0..3.
--   What the cap does NOT do. It counts REQUESTS on ONE payment_failures row. A service-role job can still set the
--   count back to 0 or write retry_requested_at itself. And process-dunning inserts a NEW payment_failures row when
--   a charge fails (index.ts:1083), so a retry pass that reused that code would start a fresh allowance of 3 after
--   every decline. The limit that protects a card must therefore also live in the retry pass, counted per quote,
--   and that pass must skip hard declines (PR #2579 comments 6045706206 finding 3 and 6045861846).
--
-- WHEN A REQUEST IS ACCEPTED (D-379: only until the homeowner notice goes out).
--   Only while dunning_status is 'active' or 'warning_sent' and resolved_at is NULL. The homeowner notice is the
--   moment process-dunning sets 'homeowner_notified'; from then on every request is refused.
--
-- EVERY STATE THE CODE CAN LEAVE A ROW IN, and what this function answers. Enumerated from
-- supabase/functions at main 7bc8a3cb (2026-10-07) by reading every .insert / .update on payment_failures:
--     dunning_status       resolved_at   written by                                         answer
--   S1 active              NULL          INSERT: process-dunning/index.ts:1083-1091;        accepted (requested /
--                                        stripe-webhook/index.ts:1037 and                   already_requested /
--                                        docusign-webhook/index.ts:1633 (column default)    limit_reached)
--   S2 warning_sent        NULL          process-dunning/index.ts:1225-1227 (final          accepted, as S1
--                                        warning sent to the contractor)
--   S3 homeowner_notified  NULL          process-dunning/index.ts:1298 and :1341            not_retryable / homeowner_notified
--                                        (the homeowner notice has gone out)
--   S4 resolved            set           process-dunning/index.ts:612 ONLY: the homeowner   not_retryable / homeowner_proceeded
--                                        clicked "Move Forward" (from S2 or S3)
--   S5 contractor_out      set           process-dunning/index.ts:662 ONLY: the homeowner   not_retryable / contractor_out
--                                        chose a different contractor (from S2 or S3)
--   The CHECK on dunning_status also allows 'escalated' and 'expired'. No code under supabase/functions writes
--   either. They, a NULL status, and any shape not listed above (for example 'active' with resolved_at set)
--   answer not_retryable / other_closed.
--   dunning_status is tested BEFORE resolved_at, because both S4 and S5 carry resolved_at.
--
-- WHAT `reason` MEANS, AND WHAT IT DOES NOT. `reason` repeats what the row says. It never says whether money is
-- owed. In particular 'resolved' / homeowner_proceeded does NOT mean the fee was paid: no code marks a failure
-- resolved because a payment succeeded, and :612 is the branch where the homeowner goes ahead while the platform
-- fee is still unpaid. What a page may say to a contractor in each case is not decided here; it belongs to the
-- page pull request and its own LEGAL-READ.
--
-- Returns {"status": requested | already_requested | not_retryable,
--          "reason": null | "homeowner_notified" | "homeowner_proceeded" | "contractor_out" | "other_closed" | "limit_reached",
--          "dunning_status": the row's dunning_status as stored (the caller can already read it: policy
--                            contractor_select_own_payment_failures),
--          "retry_requested_at": ts|null, "requests_remaining": 0..3}.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, constraint added only if absent, CREATE OR REPLACE FUNCTION, GRANT/REVOKE.

BEGIN;

ALTER TABLE public.payment_failures
  ADD COLUMN IF NOT EXISTS retry_requested_at timestamptz;

ALTER TABLE public.payment_failures
  ADD COLUMN IF NOT EXISTS retry_request_count integer NOT NULL DEFAULT 0;

DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.payment_failures'::regclass
                    AND conname = 'payment_failures_retry_request_count_check') THEN
    ALTER TABLE public.payment_failures
      ADD CONSTRAINT payment_failures_retry_request_count_check
      CHECK (retry_request_count BETWEEN 0 AND 3);
  END IF;
END
$chk$;

COMMENT ON COLUMN public.payment_failures.retry_requested_at IS
  'gh-2442 / D-379: when the contractor last asked for a payment retry via request_dunning_retry(). Set by that function only.';

COMMENT ON COLUMN public.payment_failures.retry_request_count IS
  'gh-2442 / D-379: how many retry requests request_dunning_retry() has recorded for this failure. 0..3 (CHECK); never reset by that function.';

CREATE OR REPLACE FUNCTION public.request_dunning_retry(p_failure_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_max_requests constant integer := 3;  -- D-379; the table CHECK carries the same number
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_row record;
  v_left integer;
  v_reason text;
BEGIN
  IF v_uid IS NULL OR p_failure_id IS NULL THEN
    RAISE EXCEPTION 'payment failure not found' USING ERRCODE = '42501';
  END IF;

  -- Ownership: the failure's contractor must be the caller's own contractor row. The row lock serialises two
  -- clicks, so the second one sees the first one's request (and the first one's count).
  SELECT pf.dunning_status, pf.resolved_at, pf.retry_requested_at, pf.retry_request_count
    INTO v_row
    FROM public.payment_failures pf
    JOIN public.contractors k ON k.id = pf.contractor_id
   WHERE pf.id = p_failure_id
     AND k.user_id = v_uid
     FOR UPDATE OF pf;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment failure not found' USING ERRCODE = '42501';
  END IF;

  -- Not open (S3, S4, S5 and everything unlisted). dunning_status first: S4 and S5 both carry resolved_at.
  IF v_row.dunning_status IS NULL
     OR v_row.dunning_status NOT IN ('active', 'warning_sent')
     OR v_row.resolved_at IS NOT NULL THEN
    v_reason := CASE
      WHEN v_row.dunning_status = 'homeowner_notified' AND v_row.resolved_at IS NULL THEN 'homeowner_notified'
      WHEN v_row.dunning_status = 'resolved'       THEN 'homeowner_proceeded'
      WHEN v_row.dunning_status = 'contractor_out' THEN 'contractor_out'
      ELSE 'other_closed'
    END;
    RETURN jsonb_build_object('status', 'not_retryable', 'reason', v_reason,
                              'dunning_status', v_row.dunning_status,
                              'retry_requested_at', v_row.retry_requested_at, 'requests_remaining', 0);
  END IF;

  v_left := GREATEST(c_max_requests - v_row.retry_request_count, 0);

  IF v_row.retry_requested_at IS NOT NULL
     AND v_row.retry_requested_at > v_now - interval '15 minutes' THEN
    RETURN jsonb_build_object('status', 'already_requested', 'reason', NULL,
                              'dunning_status', v_row.dunning_status,
                              'retry_requested_at', v_row.retry_requested_at, 'requests_remaining', v_left);
  END IF;

  -- The cap. Checked after the window so that a click right after the last allowed request still reads
  -- "already requested" (true), and only a later one reads "limit reached".
  IF v_row.retry_request_count >= c_max_requests THEN
    RETURN jsonb_build_object('status', 'not_retryable', 'reason', 'limit_reached',
                              'dunning_status', v_row.dunning_status,
                              'retry_requested_at', v_row.retry_requested_at, 'requests_remaining', 0);
  END IF;

  UPDATE public.payment_failures
     SET retry_requested_at = v_now,
         retry_request_count = retry_request_count + 1
   WHERE id = p_failure_id;

  RETURN jsonb_build_object('status', 'requested', 'reason', NULL,
                            'dunning_status', v_row.dunning_status,
                            'retry_requested_at', v_now, 'requests_remaining', v_left - 1);
END
$fn$;

REVOKE ALL ON FUNCTION public.request_dunning_retry(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_dunning_retry(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.request_dunning_retry(uuid) TO authenticated;

REVOKE UPDATE, TRUNCATE, TRIGGER ON public.payment_failures FROM anon;

COMMIT;
