-- STATUS (gh-1438, as of 2026-10-07T19:12Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2442_dunning_retry_request (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: payment_failures.retry_requested_at, payment_failures.retry_request_count and public.request_dunning_retry(uuid) absent on production, read-only SELECT 2026-10-07 (gh-2442 SQL-only revision); anon holds UPDATE, TRUNCATE and TRIGGER on public.payment_failures on production, same query
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md (Tier 3B path: review, R-097 notice, recorded apply)
--
-- Migration: gh2442_dunning_retry_request
-- GitHub: #2442 ([MONEY] the contractor "Retry Payment Now" button has never worked). Ruling: option A, comment 6025103626;
--         split order: PR #2579 comment 6029194857 (SQL only; the page and the retry pass are a later, separate change).
-- Tier: 3B (money-path table; adds a SECURITY DEFINER function and a REVOKE). NOT APPLIED by the authoring session or by CI.
-- Rollback: supabase/migrations_drafts/gh2442_dunning_retry_request_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2442_dunning_retry_request_pre-flight.md
-- Proof (rolled back, is_test rows only): supabase/tests/gh2442_dunning_retry_request_proof.sql
--
-- What it does.
--   1. Adds payment_failures.retry_requested_at (timestamptz, nullable, no default) and
--      payment_failures.retry_request_count (integer, NOT NULL, default 0). Nothing reads them yet except the
--      function below; a retry pass in process-dunning (a separate, later change) will. No page calls the function yet.
--   2. Adds request_dunning_retry(p_failure_id uuid) -> jsonb. SECURITY DEFINER, search_path pinned, no dynamic SQL.
--      The signed-in caller must own the failure through contractors.user_id = auth.uid(); anyone else (another
--      contractor, a homeowner, an unknown id) gets 42501 with the same message, so the function is not an oracle for
--      which ids exist. The failure must be dunning_status active or warning_sent and not resolved. The ONLY columns it
--      writes are retry_requested_at and retry_request_count. A second call within 15 minutes of the stored request
--      writes nothing and returns the existing request.
--      CAP: at most 3 recorded requests per failure, for the life of the row (the constant c_max_requests). The
--      15-minute window alone allowed a request to be renewed 96 times a day; with the cap, a failure can never
--      carry more than 3 requests, whatever any page or later job does. The count is never reset by this function.
--      Returns {"status": requested | already_requested | not_retryable,
--               "reason": null | "resolved" | "closed" | "limit_reached",
--               "retry_requested_at": ts|null, "requests_remaining": 0..3}.
--      REASON exists so a page never has to guess why a failure is not retryable: "resolved" means the failure is
--      already settled (resolved_at set or dunning_status = resolved) and the contractor owes nothing on it, so a
--      page must NOT answer it with "update your card"; "closed" means it left the retryable states another way
--      (homeowner_notified, contractor_out, escalated, expired); "limit_reached" means the cap above.
--   3. Grants EXECUTE to authenticated only (revoked from PUBLIC and anon). This is a NEW GRANT to `authenticated`:
--      when this file is filed under supabase/migrations/ the "No new GRANT to anon/PUBLIC/authenticated" check
--      (permissions-ratchet) needs the PR label `permissions-ratchet: reviewed`.
--   4. Revokes anon UPDATE, TRUNCATE and TRIGGER on payment_failures. RLS already blocked anon rows; the grants were
--      only a missing second lock. anon SELECT and REFERENCES are left as they are (no anon policy exists, so SELECT
--      returns nothing); they are not writes. authenticated's own table grants are NOT changed here (see pre-flight).
--      The rollback file does NOT give these three back.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION, GRANT/REVOKE.

BEGIN;

ALTER TABLE public.payment_failures
  ADD COLUMN IF NOT EXISTS retry_requested_at timestamptz;

ALTER TABLE public.payment_failures
  ADD COLUMN IF NOT EXISTS retry_request_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.payment_failures.retry_requested_at IS
  'gh-2442: when the contractor last asked for a payment retry via request_dunning_retry(). Set by that function only.';

COMMENT ON COLUMN public.payment_failures.retry_request_count IS
  'gh-2442: how many retry requests request_dunning_retry() has recorded for this failure. Capped at 3 by that function; never reset by it.';

CREATE OR REPLACE FUNCTION public.request_dunning_retry(p_failure_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_max_requests constant integer := 3;
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_row record;
  v_left integer;
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

  v_left := GREATEST(c_max_requests - v_row.retry_request_count, 0);

  -- Already settled: say so, distinctly. The caller owes nothing on this failure.
  IF v_row.resolved_at IS NOT NULL OR v_row.dunning_status = 'resolved' THEN
    RETURN jsonb_build_object('status', 'not_retryable', 'reason', 'resolved',
                              'retry_requested_at', v_row.retry_requested_at, 'requests_remaining', 0);
  END IF;

  -- Left the retryable states some other way.
  IF v_row.dunning_status IS NULL OR v_row.dunning_status NOT IN ('active', 'warning_sent') THEN
    RETURN jsonb_build_object('status', 'not_retryable', 'reason', 'closed',
                              'retry_requested_at', v_row.retry_requested_at, 'requests_remaining', 0);
  END IF;

  IF v_row.retry_requested_at IS NOT NULL
     AND v_row.retry_requested_at > v_now - interval '15 minutes' THEN
    RETURN jsonb_build_object('status', 'already_requested', 'reason', NULL,
                              'retry_requested_at', v_row.retry_requested_at, 'requests_remaining', v_left);
  END IF;

  -- The cap. Checked after the window so that a click right after the last allowed request still reads
  -- "already requested" (true), and only a later one reads "limit reached".
  IF v_row.retry_request_count >= c_max_requests THEN
    RETURN jsonb_build_object('status', 'not_retryable', 'reason', 'limit_reached',
                              'retry_requested_at', v_row.retry_requested_at, 'requests_remaining', 0);
  END IF;

  UPDATE public.payment_failures
     SET retry_requested_at = v_now,
         retry_request_count = retry_request_count + 1
   WHERE id = p_failure_id;

  RETURN jsonb_build_object('status', 'requested', 'reason', NULL,
                            'retry_requested_at', v_now, 'requests_remaining', v_left - 1);
END
$fn$;

REVOKE ALL ON FUNCTION public.request_dunning_retry(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_dunning_retry(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.request_dunning_retry(uuid) TO authenticated;

REVOKE UPDATE, TRUNCATE, TRIGGER ON public.payment_failures FROM anon;

COMMIT;
