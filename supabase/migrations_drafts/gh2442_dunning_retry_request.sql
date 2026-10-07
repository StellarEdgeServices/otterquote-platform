-- STATUS (gh-1438, as of 2026-10-07T23:53Z): NOT APPLIED
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
--      which ids exist. The ONLY columns it writes are retry_requested_at and retry_request_count, and only on the
--      row it was called with. A second call within 15 minutes of the stored request writes nothing.
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
-- "A FAILED PAYMENT" IS THE QUOTE, NOT THE ROW (REVIEW 6049015214, finding 1).
--   On main 7bc8a3cb one failed charge writes TWO payment_failures rows for the same quote:
--     - the webhook row: stripe-webhook/index.ts:1037 or docusign-webhook/index.ts:1633 inserts quote, contractor,
--       claim, amount and error only. dunning_status takes its default 'active'; next_reminder_at, warning_at and
--       homeowner_notify_at stay NULL. No code ever updates this row, so it stays 'active' for ever.
--     - the scheduled row: the webhook then calls process-dunning, which inserts a second row at index.ts:1083 with
--       the schedule filled in. Only this row moves through the states below.
--   And when process-dunning charges an alternate saved method successfully it returns before :1083 (index.ts:958,
--   "Dunning not initiated"); the webhook row is then the only row, still 'active', for a fee that was collected.
--   That double insert is a defect on main and is NOT fixed here; it gets its own issue. This function is written
--   to be correct WITH OR WITHOUT it: every test below is made over the GROUP of the caller's payment_failures rows
--   that share the called row's quote_id and contractor_id (a row with no quote_id is a group of one), so one row
--   per quote, two rows per quote, or more all answer the same way, whichever row the page sends.
--     - one cutoff:  if ANY row of the group has left the open states, every row of the group refuses;
--     - one count:   the cap is tested against the SUM of retry_request_count over the group;
--     - one window:  the 15 minutes run from the LATEST retry_requested_at in the group;
--     - a dunning sequence must exist: at least one row of the group must carry a schedule (homeowner_notify_at
--       not NULL). A webhook row on its own (the alternate-method case, or the seconds before process-dunning has
--       inserted its row) refuses with reason no_dunning_schedule.
--
-- WHERE THE PER-QUOTE COUNT LIVES, AND WHY. It is the sum of retry_request_count over the rows of the group, read
--   after the function has locked every row of the group (FOR UPDATE, in id order, so two callers always take the
--   locks in the same order and cannot deadlock). The row the function was called with is NOT locked first: it is
--   read plainly for ownership and for its quote, and locked only as part of the ordered group.
--   Why a sum over locked rows and not a separate per-quote table: the rows are the only place the dunning state
--   lives, so they must be read and locked for the cutoff anyway; a second table would be a second money-path
--   object with its own grants, row security and rollback, and a second place for the count to disagree with the
--   rows. Two callers on different rows of one quote always meet on a lock, because both groups contain every
--   committed row of that quote, including the oldest.
--   What the retry pass must do with this: read a request per QUOTE (latest retry_requested_at, summed count),
--   never per row.
--
-- THE CAP (D-379: up to 3 per failed payment). Held in two places, which guarantee different things:
--   - the function: c_max_requests = 3, tested against the group sum under the locks. This is the per-quote cap.
--   - the table: CHECK (retry_request_count BETWEEN 0 AND 3). This is a per-ROW bound. It guarantees that no
--     writer of any role, including a service-role job, can store a count outside 0..3 on any one row. It does
--     NOT by itself guarantee 3 per quote: two rows of one quote could each be set to 3 by a service-role writer.
--     Through this function they cannot, because the sum is tested before every write.
--   What neither does. A service-role job can still set counts back to 0 or write retry_requested_at itself. And
--   a retry pass that inserted a further payment_failures row for the same quote on each decline (as :1083 does
--   today) would NOT earn a fresh allowance here, because the count is per quote; the retry pass must still keep
--   its own limit on charge attempts per quote and must skip hard declines (PR #2579 comments 6045706206
--   finding 3 and 6045861846).
--
-- WHEN A REQUEST IS ACCEPTED (D-379: only until the homeowner notice goes out).
--   Only while every row of the group is 'active' or 'warning_sent' with resolved_at NULL, and at least one row
--   carries a schedule. The homeowner notice is the moment process-dunning sets 'homeowner_notified' on the
--   scheduled row; from then on every row of that quote refuses.
--
-- EVERY STATE THE CODE CAN LEAVE A ROW IN. Enumerated from supabase/functions at main 7bc8a3cb (2026-10-07) by
-- reading every .insert / .update on payment_failures (3 inserts; 7 updates, all in process-dunning/index.ts):
--     dunning_status       resolved_at   schedule   written by
--   W  active              NULL          NULL       the webhook row: stripe-webhook/index.ts:1037,
--                                                   docusign-webhook/index.ts:1633. Never updated afterwards.
--   S1 active              NULL          set        process-dunning/index.ts:1083-1097 (the scheduled row)
--   S2 warning_sent        NULL          set        process-dunning/index.ts:1225-1227 (final warning sent)
--   S3 homeowner_notified  NULL          set        process-dunning/index.ts:1298 and :1341 (notice has gone out)
--   S4 resolved            set           set        process-dunning/index.ts:612 ONLY: the homeowner clicked
--                                                   "Move Forward" (from S2 or S3)
--   S5 contractor_out      set           set        process-dunning/index.ts:662 ONLY: the homeowner chose a
--                                                   different contractor (from S2 or S3)
--   The CHECK on dunning_status also allows 'escalated' and 'expired'. No code under supabase/functions writes
--   either. They, a NULL status, and any shape not listed above (for example 'active' with resolved_at set)
--   count as closed, reason other_closed.
--
-- THE GROUPS THAT CAN THEREFORE EXIST FOR ONE QUOTE, and the answer (the same for every row of the group):
--   W alone                    not_retryable / no_dunning_schedule   (alternate method charged, or dunning not yet started)
--   W + S1, or S1 alone        accepted                              (requested / already_requested / limit_reached)
--   W + S2, or S2 alone        accepted
--   W + S3, or S3 alone        not_retryable / homeowner_notified
--   W + S4, or S4 alone        not_retryable / homeowner_proceeded
--   W + S5, or S5 alone        not_retryable / contractor_out
--   When more than one row of a group is closed the reason is taken in this order: contractor_out,
--   homeowner_proceeded, homeowner_notified, other_closed. dunning_status is tested BEFORE resolved_at, because
--   S4 and S5 both carry resolved_at.
--
-- WHAT `reason` MEANS, AND WHAT IT DOES NOT. `reason` repeats what the rows say. It never says whether money is
-- owed. In particular 'resolved' / homeowner_proceeded does NOT mean the fee was paid: no code marks a failure
-- resolved because a payment succeeded, and :612 is the branch where the homeowner goes ahead while the platform
-- fee is still unpaid. no_dunning_schedule likewise says only that no row of the quote carries a schedule. What a
-- page may say to a contractor in each case is not decided here; it belongs to the page pull request and its own
-- LEGAL-READ.
--
-- Returns {"status": requested | already_requested | not_retryable,
--          "reason": null | "homeowner_notified" | "homeowner_proceeded" | "contractor_out" | "other_closed"
--                         | "no_dunning_schedule" | "limit_reached",
--          "dunning_status": the stored dunning_status of the row that decided the answer (the closed row when
--                            one exists; otherwise warning_sent if any row of the group is, else active). The
--                            caller can already read it: policy contractor_select_own_payment_failures.
--          "retry_requested_at": the latest request recorded for the quote, ts|null,
--          "requests_remaining": 0..3, for the quote}.
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
  'gh-2442 / D-379: when the contractor last asked for a payment retry on this row via request_dunning_retry(). The latest value over the rows of a quote is the quote''s last request. Set by that function only.';

COMMENT ON COLUMN public.payment_failures.retry_request_count IS
  'gh-2442 / D-379: how many retry requests request_dunning_retry() has recorded on this row. The cap of 3 is per quote: that function sums this column over the rows of the quote. 0..3 per row (CHECK); never reset by that function.';

CREATE OR REPLACE FUNCTION public.request_dunning_retry(p_failure_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_max_requests constant integer := 3;  -- D-379, per failed payment (the quote); the table CHECK bounds each row
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_quote uuid;
  v_contractor uuid;
  v_row record;
  v_seen_target boolean := false;
  v_total integer := 0;            -- requests recorded for the quote
  v_last timestamptz;              -- latest request recorded for the quote
  v_scheduled boolean := false;    -- some row of the group carries a dunning schedule
  v_open_status text := 'active';
  v_closed_rank integer := 0;      -- 0 = no closed row in the group
  v_closed_status text;
  v_rank integer;
  v_reason text;
  v_left integer;
BEGIN
  IF v_uid IS NULL OR p_failure_id IS NULL THEN
    RAISE EXCEPTION 'payment failure not found' USING ERRCODE = '42501';
  END IF;

  -- Ownership, and which failed payment this is. Read without a lock: the locks are taken below, over the whole
  -- group and in id order, so that two callers on two rows of one quote can never wait on each other in a ring.
  SELECT pf.quote_id, pf.contractor_id
    INTO v_quote, v_contractor
    FROM public.payment_failures pf
    JOIN public.contractors k ON k.id = pf.contractor_id
   WHERE pf.id = p_failure_id
     AND k.user_id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment failure not found' USING ERRCODE = '42501';
  END IF;

  -- The group: every row of this contractor for the same quote (a row with no quote is a group of one).
  -- Locked in id order; a second caller waits here and then reads the first caller's committed write.
  FOR v_row IN
    SELECT pf.id, pf.dunning_status, pf.resolved_at, pf.homeowner_notify_at,
           pf.retry_requested_at, pf.retry_request_count
      FROM public.payment_failures pf
     WHERE pf.contractor_id = v_contractor
       AND (pf.id = p_failure_id OR (v_quote IS NOT NULL AND pf.quote_id = v_quote))
     ORDER BY pf.id
       FOR UPDATE OF pf
  LOOP
    IF v_row.id = p_failure_id THEN
      v_seen_target := true;
    END IF;
    v_total := v_total + v_row.retry_request_count;
    IF v_row.retry_requested_at IS NOT NULL AND (v_last IS NULL OR v_row.retry_requested_at > v_last) THEN
      v_last := v_row.retry_requested_at;
    END IF;
    IF v_row.homeowner_notify_at IS NOT NULL THEN
      v_scheduled := true;
    END IF;

    IF v_row.dunning_status IS NULL
       OR v_row.dunning_status NOT IN ('active', 'warning_sent')
       OR v_row.resolved_at IS NOT NULL THEN
      -- A closed row. dunning_status first: S4 and S5 both carry resolved_at.
      v_rank := CASE
        WHEN v_row.dunning_status = 'contractor_out' THEN 4
        WHEN v_row.dunning_status = 'resolved'       THEN 3
        WHEN v_row.dunning_status = 'homeowner_notified' AND v_row.resolved_at IS NULL THEN 2
        ELSE 1
      END;
      IF v_rank > v_closed_rank THEN
        v_closed_rank := v_rank;
        v_closed_status := v_row.dunning_status;
      END IF;
    ELSIF v_row.dunning_status = 'warning_sent' THEN
      v_open_status := 'warning_sent';
    END IF;
  END LOOP;

  IF NOT v_seen_target THEN
    -- the row was there for the ownership read and is gone or re-assigned now
    RAISE EXCEPTION 'payment failure not found' USING ERRCODE = '42501';
  END IF;

  -- One cutoff for the quote: any closed row closes every row.
  IF v_closed_rank > 0 THEN
    v_reason := CASE v_closed_rank
      WHEN 4 THEN 'contractor_out'
      WHEN 3 THEN 'homeowner_proceeded'
      WHEN 2 THEN 'homeowner_notified'
      ELSE 'other_closed'
    END;
    RETURN jsonb_build_object('status', 'not_retryable', 'reason', v_reason,
                              'dunning_status', v_closed_status,
                              'retry_requested_at', v_last, 'requests_remaining', 0);
  END IF;

  -- No dunning sequence exists for this quote (a webhook row on its own).
  IF NOT v_scheduled THEN
    RETURN jsonb_build_object('status', 'not_retryable', 'reason', 'no_dunning_schedule',
                              'dunning_status', v_open_status,
                              'retry_requested_at', v_last, 'requests_remaining', 0);
  END IF;

  v_left := GREATEST(c_max_requests - v_total, 0);

  -- One window for the quote.
  IF v_last IS NOT NULL AND v_last > v_now - interval '15 minutes' THEN
    RETURN jsonb_build_object('status', 'already_requested', 'reason', NULL,
                              'dunning_status', v_open_status,
                              'retry_requested_at', v_last, 'requests_remaining', v_left);
  END IF;

  -- One count for the quote. Checked after the window so that a click right after the last allowed request
  -- still reads "already requested" (true), and only a later one reads "limit reached".
  IF v_total >= c_max_requests THEN
    RETURN jsonb_build_object('status', 'not_retryable', 'reason', 'limit_reached',
                              'dunning_status', v_open_status,
                              'retry_requested_at', v_last, 'requests_remaining', 0);
  END IF;

  UPDATE public.payment_failures
     SET retry_requested_at = v_now,
         retry_request_count = retry_request_count + 1
   WHERE id = p_failure_id;

  RETURN jsonb_build_object('status', 'requested', 'reason', NULL,
                            'dunning_status', v_open_status,
                            'retry_requested_at', v_now, 'requests_remaining', v_left - 1);
END
$fn$;

REVOKE ALL ON FUNCTION public.request_dunning_retry(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_dunning_retry(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.request_dunning_retry(uuid) TO authenticated;

REVOKE UPDATE, TRUNCATE, TRIGGER ON public.payment_failures FROM anon;

COMMIT;
