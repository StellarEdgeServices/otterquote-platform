-- STATUS (gh-1438, as of 2026-10-19T20:20:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2442_dunning_retry_unknown_guard
-- EVIDENCE: function body taken from the APPLIED gh2442_dunning_retry_request.sql (ledger 20261009000257) with the one change below; proved on a scratch PostgreSQL (see the proof file), not on production
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md (Tier 3B path: review, R-097 notice, recorded apply)
--
-- Migration: gh2442_dunning_retry_unknown_guard
-- GitHub: #2442, PR #2927 (REVIEW 6276208597 C2; design ruling: Marty, Tier A).
-- Tier: 3B (replaces a SECURITY DEFINER function on a money-path table). NOT APPLIED by the authoring session or CI.
-- Rollback: supabase/migrations_drafts/gh2442_dunning_retry_unknown_guard_rollback.sql
-- Proof: supabase/tests/gh2442_dunning_retry_unknown_guard_proof.sql
-- REQUIRES gh2442_dunning_retry_pass_column.sql applied FIRST (it adds payment_failures.retry_unknown_at).
--
-- What it changes. request_dunning_retry() now refuses, writing nothing, while ANY row of the quote carries
-- retry_unknown_at (an in-doubt Stripe attempt): {"status":"not_retryable","reason":"unknown_outcome_pending"}.
-- Why: the retry pass resolves an in-doubt attempt only by replaying its stored idempotency key; a new request must not
-- add a charge on top of a fee that may already be collected, and must not move the stored attempt. The page shows its
-- existing generic error string for every not_retryable reason, so no customer-facing text changes.
-- Checked after the closed-row and no-schedule refusals and before the 15-minute window and the cap, so those answers
-- are unchanged. Everything else in the function is byte-identical to the applied version. Grants are re-asserted
-- (CREATE OR REPLACE keeps them); nothing else is touched.
BEGIN;

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
  v_unknown boolean := false;      -- some row of the group carries an in-doubt Stripe attempt (retry_unknown_at)
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
           pf.retry_requested_at, pf.retry_request_count, pf.retry_unknown_at
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
    IF v_row.retry_unknown_at IS NOT NULL THEN
      v_unknown := true;
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

  -- An earlier attempt for this quote ended with an unknown Stripe outcome and has not been resolved yet. Record
  -- nothing: the pass resolves that attempt by replaying its stored idempotency key, and a new request must neither
  -- add a charge on top of a possibly-paid fee nor disturb the stored attempt. Reason code only; no new page text.
  IF v_unknown THEN
    RETURN jsonb_build_object('status', 'not_retryable', 'reason', 'unknown_outcome_pending',
                              'dunning_status', v_open_status,
                              'retry_requested_at', v_last, 'requests_remaining', GREATEST(c_max_requests - v_total, 0));
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

COMMIT;
