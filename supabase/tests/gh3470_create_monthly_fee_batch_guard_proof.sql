-- gh-3470 proof, THROWAWAY Postgres only (never production). Run by gh3470_create_monthly_fee_batch_guard_local_run.sh.
-- Matrix: 2 definitions of public.is_admin_email() (p18 = returns NULL on a JWT without an email claim; gh3009 = the live EXISTS() form, never NULL)
--         x 2 bodies of create_monthly_fee_batch (TODAY = live gh3229 body, FIXED = this migration) x 4 callers.
-- Each call runs in a sub-transaction that is rolled back, so every case sees the same seed (1 partner, 6 accrued events of 500 cents, minimum 2500).
CREATE OR REPLACE FUNCTION public.gh3470_try(p_role text, p_claims text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_res jsonb; v_out text; v_pay int; v_bat int;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', p_claims, true);
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    v_res := public.create_monthly_fee_batch(date '2020-01-01');
    RESET ROLE;
    SELECT count(*) INTO v_pay FROM public.payout_approvals;
    SELECT count(*) INTO v_bat FROM public.partner_fee_events WHERE status = 'batched';
    v_out := 'ADMITTED payouts=' || v_pay || ' batched=' || v_bat;
    RAISE EXCEPTION 'gh3470_rollback' USING ERRCODE = 'XX999';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN v_out := 'REFUSED 42501';
    WHEN SQLSTATE 'XX999' THEN NULL;
  END;
  RESET ROLE;
  RETURN v_out;
END $f$;
