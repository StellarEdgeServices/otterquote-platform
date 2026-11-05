-- STATUS (gh-1438, as of 2026-11-05T22:40:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3470_create_monthly_fee_batch_guard_fail_closed (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-11-05 under #3470. Production read-only SELECT (project yeszghaspzwwstvsrioa, 2026-11-05): pg_get_functiondef(public.create_monthly_fee_batch(date)) md5 a8f66ee8688a71d710d05a644623c4a6, 3871 chars,
--   prosrc md5 1e48a0254db3b738f03f09d731ea90cf; the function body below equals that definition except the one guard line (byte-compared, see the pre-flight). Ledger version 20261105194055 (gh3229). No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3470_create_monthly_fee_batch_guard_fail_closed
-- GitHub: #3470. Tier 3B (CTO ruling, #3470 comment 'A:'), R-134 fast path: the only effect is restoring an auth check. REVIEW + LEGAL-READ + Ben's signature still apply (money path).
-- Rollback: gh3470_create_monthly_fee_batch_guard_fail_closed_rollback.sql   Pre-flight: gh3470_create_monthly_fee_batch_guard_fail_closed_pre-flight.md
-- Proof: supabase/tests/gh3470_create_monthly_fee_batch_guard_proof.sql   Local run: supabase/tests/gh3470_create_monthly_fee_batch_guard_local_run.sh
--
-- What this file does
--   Replaces public.create_monthly_fee_batch(date) so the admin-or-service-role guard fails closed: public.is_admin_email() is wrapped in COALESCE(..., false).
--   A boolean NULL from is_admin_email() (a JWT with no email claim, in the p18 definition) made NOT(false OR NULL) = NULL, IF did not fire and the body ran.
--   Nothing else in the body changes. CREATE OR REPLACE keeps owner, ACL (authenticated, service_role; anon and PUBLIC revoked), SET search_path and the COMMENT.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- refuse to replace a body that is not the one this file was byte-compared against
DO $g$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.create_monthly_fee_batch(date)'::regprocedure) IS DISTINCT FROM '1e48a0254db3b738f03f09d731ea90cf' THEN
    RAISE EXCEPTION 'gh3470: public.create_monthly_fee_batch(date) body is not the gh3229 body this migration was written against; re-diff before applying';
  END IF;
END
$g$;

CREATE OR REPLACE FUNCTION public.create_monthly_fee_batch(p_month date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_month    date;
  v_end      timestamptz;
  v_setting  text;
  v_min      bigint;
  r          record;
  v_payout   uuid;
  v_updated  integer;
  v_created  integer := 0;
  v_batched  integer := 0;
  v_under    integer := 0;
  v_blocked  integer := 0;
  v_total    bigint  := 0;
BEGIN
  IF NOT (COALESCE(auth.role(), '') = 'service_role' OR COALESCE(public.is_admin_email(), false)) THEN
    RAISE EXCEPTION 'create_monthly_fee_batch: admin or service role only' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'create_monthly_fee_batch: p_month is required' USING ERRCODE = '22023';
  END IF;

  v_month := date_trunc('month', p_month)::date;
  -- only a month that has ended can be batched: an accrual landing during the run could not otherwise be told from the batch's own rows
  IF v_month >= date_trunc('month', now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'create_monthly_fee_batch: % is the current or a future month (Eastern time)', v_month USING ERRCODE = '22023';
  END IF;
  -- month boundary = midnight America/New_York (the business day), not UTC; everything accrued before it, rollover included
  v_end := ((v_month + interval '1 month')::timestamp AT TIME ZONE 'America/New_York');

  -- two clicks at once serialize here; the second finds nothing left to batch
  PERFORM pg_advisory_xact_lock(hashtext('create_monthly_fee_batch'));

  SELECT s.value #>> '{}' INTO v_setting FROM public.platform_settings s WHERE s.key = 'partner_payout_minimum_cents';
  v_min := CASE WHEN v_setting ~ '^[0-9]{1,7}$' THEN v_setting::bigint ELSE 2500 END;

  FOR r IN
    SELECT e.referral_agent_id AS agent_id, e.is_test, sum(e.amount_cents)::bigint AS total, count(*)::integer AS n,
           a.first_name, a.last_name, a.payments_blocked
      FROM public.partner_fee_events e
      JOIN public.referral_agents a ON a.id = e.referral_agent_id
     WHERE e.status = 'accrued' AND e.created_at < v_end
     GROUP BY e.referral_agent_id, e.is_test, a.first_name, a.last_name, a.payments_blocked
     ORDER BY e.referral_agent_id, e.is_test
  LOOP
    IF r.payments_blocked THEN
      v_blocked := v_blocked + 1;
      CONTINUE;                                    -- stays accrued
    END IF;
    IF r.total < v_min THEN
      v_under := v_under + 1;
      CONTINUE;                                    -- rolls over
    END IF;

    INSERT INTO public.payout_approvals
      (referral_id, payout_type, partner_id, partner_name, amount, trigger_event, status, auto_approve_at, is_test)
    VALUES
      (NULL, 'measurement_fees_monthly', r.agent_id,
       btrim(COALESCE(r.first_name, '') || ' ' || COALESCE(r.last_name, '')),
       round(r.total / 100.0, 2),
       'Measurement referral fees through ' || to_char(v_month, 'Mon YYYY') || ' (' || r.n || ' measurements)',
       'pending_approval', NULL, r.is_test)
    RETURNING id INTO v_payout;

    UPDATE public.partner_fee_events
       SET status = 'batched', payout_approval_id = v_payout
     WHERE referral_agent_id = r.agent_id AND is_test = r.is_test AND status = 'accrued' AND created_at < v_end;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> r.n THEN
      RAISE EXCEPTION 'create_monthly_fee_batch: batched % events for partner %, expected %', v_updated, r.agent_id, r.n;
    END IF;

    v_created := v_created + 1;
    v_batched := v_batched + v_updated;
    v_total   := v_total + r.total;
  END LOOP;

  RETURN jsonb_build_object(
    'month', v_month, 'payouts_created', v_created, 'events_batched', v_batched, 'total_cents', v_total,
    'under_minimum_partners', v_under, 'payments_blocked_partners', v_blocked, 'minimum_cents', v_min);
END;
$function$;

COMMIT;
