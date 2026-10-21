-- gh-2442 proof: request_dunning_retry() refuses while an in-doubt Stripe attempt (retry_unknown_at) is set.
-- Set gh2442_dunning_retry_unknown_guard (forward + rollback). GENERATED: the function bodies below are copied
-- verbatim from the forward file (NEW) and from the rollback file (ORIGINAL = the applied 20261009000257 body).
-- RUNS ON A SCRATCH POSTGRES (a replica of just the tables the function reads), NOT on production: it creates
-- roles, an auth schema and two tables, so do not point it at a real database. Run it as one script; the last
-- statement prints the proof table. Expected results are in the 'expect' column; a mismatch is a failure.
-- Run on PGlite (PostgreSQL 18.6 WASM) by the authoring session on 2026-10-19; a run on production's own PostgreSQL
-- belongs to the applier (use the rolled-back DO-block form of gh2442_dunning_retry_request_proof.sql).
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $r$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE TABLE public.contractors (id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE public.payment_failures (
  id uuid PRIMARY KEY, quote_id uuid, contractor_id uuid NOT NULL, claim_id uuid, amount_cents integer,
  dunning_status text NOT NULL DEFAULT 'active', resolved_at timestamptz, homeowner_notify_at timestamptz,
  next_reminder_at timestamptz, retry_requested_at timestamptz,
  retry_request_count integer NOT NULL DEFAULT 0 CHECK (retry_request_count BETWEEN 0 AND 3));
ALTER TABLE public.payment_failures ADD COLUMN retry_unknown_at timestamptz;  -- gh2442_dunning_retry_pass_column.sql
CREATE TABLE proof (n serial PRIMARY KEY, label text, result text, expect text);
CREATE FUNCTION pcall(p_uid uuid, p_fid uuid) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid)::text, true);
  r := public.request_dunning_retry(p_fid);
  RETURN (r->>'status') || '/' || coalesce(r->>'reason','-');
EXCEPTION WHEN OTHERS THEN RETURN 'REJECTED ' || SQLSTATE;
END $f$;
CREATE FUNCTION pstate(p_fid uuid) RETURNS text LANGUAGE sql AS
  $$ SELECT 'count=' || retry_request_count || ' req=' || coalesce(to_char(retry_requested_at,'HH24:MI:SS'),'-') FROM public.payment_failures WHERE id = p_fid $$;
-- fixtures: owner k1 (user u1), other contractor k2 (user u2); quote Q with webhook row W (no schedule) and scheduled row S
INSERT INTO public.contractors VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1'),
                                      ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000b2');
INSERT INTO public.payment_failures (id, quote_id, contractor_id, dunning_status, homeowner_notify_at) VALUES
 ('00000000-0000-0000-0000-00000000ee01','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1','active',NULL),
 ('00000000-0000-0000-0000-00000000ee02','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1','warning_sent', now() + interval '10 hours');
-- ===== ORIGINAL (applied) function =====
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
GRANT EXECUTE ON FUNCTION public.request_dunning_retry(uuid) TO authenticated;
-- BEFORE (negative control): the original function ACCEPTS a request while an attempt is in doubt
UPDATE public.payment_failures SET retry_unknown_at = now() WHERE id = '00000000-0000-0000-0000-00000000ee02';
INSERT INTO proof(label,result,expect) VALUES ('BEFORE owner requests on W while S is in doubt', pcall('00000000-0000-0000-0000-0000000000b1'::uuid,'00000000-0000-0000-0000-00000000ee01'::uuid), 'requested/-  (the defect)');
UPDATE public.payment_failures SET retry_requested_at=NULL, retry_request_count=0, retry_unknown_at=NULL;
-- ===== FORWARD (gh2442_dunning_retry_unknown_guard.sql) =====
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
GRANT EXECUTE ON FUNCTION public.request_dunning_retry(uuid) TO authenticated;
INSERT INTO proof(label,result,expect) VALUES ('AFTER no marker: owner on W (normal path unchanged)', pcall('00000000-0000-0000-0000-0000000000b1'::uuid,'00000000-0000-0000-0000-00000000ee01'::uuid), 'requested/-');
INSERT INTO proof(label,result,expect) VALUES ('AFTER no marker: same instant', pcall('00000000-0000-0000-0000-0000000000b1'::uuid,'00000000-0000-0000-0000-00000000ee01'::uuid), 'already_requested/-');
UPDATE public.payment_failures SET retry_requested_at=NULL, retry_request_count=0, retry_unknown_at=NULL;
UPDATE public.payment_failures SET retry_unknown_at = now() WHERE id = '00000000-0000-0000-0000-00000000ee02';
INSERT INTO proof(label,result,expect) VALUES ('AFTER marker on S: owner on W refused', pcall('00000000-0000-0000-0000-0000000000b1'::uuid,'00000000-0000-0000-0000-00000000ee01'::uuid), 'not_retryable/unknown_outcome_pending');
INSERT INTO proof(label,result,expect) VALUES ('AFTER marker on S: owner on S refused', pcall('00000000-0000-0000-0000-0000000000b1'::uuid,'00000000-0000-0000-0000-00000000ee02'::uuid), 'not_retryable/unknown_outcome_pending');
INSERT INTO proof(label,result,expect) VALUES ('AFTER marker on S: nothing written on W', pstate('00000000-0000-0000-0000-00000000ee01'::uuid), 'count=0 req=-');
INSERT INTO proof(label,result,expect) VALUES ('AFTER marker on S: nothing written on S', pstate('00000000-0000-0000-0000-00000000ee02'::uuid), 'count=0 req=-');
INSERT INTO proof(label,result,expect) VALUES ('AFTER marker on S: another contractor still rejected', pcall('00000000-0000-0000-0000-0000000000b2'::uuid,'00000000-0000-0000-0000-00000000ee01'::uuid), 'REJECTED 42501');
INSERT INTO proof(label,result,expect) VALUES ('AFTER marker on S: no login rejected', pcall(NULL::uuid,'00000000-0000-0000-0000-00000000ee01'::uuid), 'REJECTED 42501');
UPDATE public.payment_failures SET retry_unknown_at=NULL;
INSERT INTO proof(label,result,expect) VALUES ('AFTER marker cleared: owner on W requested again', pcall('00000000-0000-0000-0000-0000000000b1'::uuid,'00000000-0000-0000-0000-00000000ee01'::uuid), 'requested/-');
UPDATE public.payment_failures SET dunning_status='homeowner_notified' WHERE id='00000000-0000-0000-0000-00000000ee02'; UPDATE public.payment_failures SET retry_unknown_at=now() WHERE id='00000000-0000-0000-0000-00000000ee02';
INSERT INTO proof(label,result,expect) VALUES ('AFTER marker + notified: the closed-row answer wins (unchanged precedence)', pcall('00000000-0000-0000-0000-0000000000b1'::uuid,'00000000-0000-0000-0000-00000000ee01'::uuid), 'not_retryable/homeowner_notified');
UPDATE public.payment_failures SET dunning_status='warning_sent', retry_unknown_at=NULL, retry_requested_at=NULL, retry_request_count=0;
-- ===== ROLLBACK (gh2442_dunning_retry_unknown_guard_rollback.sql) =====
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
GRANT EXECUTE ON FUNCTION public.request_dunning_retry(uuid) TO authenticated;
UPDATE public.payment_failures SET retry_unknown_at = now() WHERE id = '00000000-0000-0000-0000-00000000ee02';
INSERT INTO proof(label,result,expect) VALUES ('ROLLED-BACK marker on S: original behaviour back (accepts)', pcall('00000000-0000-0000-0000-0000000000b1'::uuid,'00000000-0000-0000-0000-00000000ee01'::uuid), 'requested/-');
SELECT n, label, result, expect, CASE WHEN result = split_part(expect,'  (',1) THEN 'OK' ELSE 'MISMATCH' END AS verdict FROM proof ORDER BY n;
