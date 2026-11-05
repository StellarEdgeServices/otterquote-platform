-- STATUS (gh-1438, as of 2026-11-05T22:40:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3470_create_monthly_fee_batch_guard_fail_closed (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-11-05 under #3470. Restores the production definition read 2026-11-05 (pg_get_functiondef md5 a8f66ee8688a71d710d05a644623c4a6), guard line included. No database was written to produce this file.
-- REPO COPY: none. When applied, move to supabase/migrations_rollbacks/ beside the filed forward migration.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback of gh3470_create_monthly_fee_batch_guard_fail_closed: puts back the gh3229 body with the NULL-unsafe guard. Only use it if the forward body is itself the problem;
-- the restored guard is only safe while public.is_admin_email() never returns NULL (true under the gh3009 definition, not under the p18 one).
BEGIN;
SET LOCAL lock_timeout = '5s';

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
  IF NOT (COALESCE(auth.role(), '') = 'service_role' OR public.is_admin_email()) THEN
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
