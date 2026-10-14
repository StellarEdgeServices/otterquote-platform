-- gh-2519 / gh-2564 / gh-2626 composition proof: attempts on the paths where the gh-2519 clean-up and the gh-2626 quote rules meet.
-- Run on a THROWAWAY Postgres only (supabase/tests/gh2519_gh2564_gh2626_compose_proof_run.sh does it); never point it at production.
-- Same schema, helpers and fixtures as gh2626_claims_award_columns_guard_proof.sql (copied from its lines 17 to 93). One transaction that
-- ends in ROLLBACK and prints one line per attempt. Lines: C1 the claim owner selects a bid directly while a switched-away bid (status selected,
-- claim back in bidding with no selected contractor) is still on the claim: the gh-2519 clean-up declines that leftover bid inside the trigger,
-- and the gh-2626 rule "declined only from submitted" must not refuse the clean-up. C2 the same through accept_bid(). C3 a repeated accept of
-- the live winner on a signed claim writes nothing. C4 accept_bid() on the switched-away bid is refused (gh-2626 DECIDED 1 / review B1).
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE proof_log(n serial, line text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_email text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 95);
  END;
END $f$;
CREATE TEMP TABLE fx(k text PRIMARY KEY, v uuid);
GRANT SELECT ON fx TO authenticated, anon, service_role;
-- fixtures (as the table owner)
DO $fix$
DECLARE c uuid; cd uuid; owner_id uuid := gen_random_uuid(); v_k uuid; v_q uuid;
BEGIN
  INSERT INTO fx VALUES ('owner', owner_id), ('other', gen_random_uuid());
  INSERT INTO public.claims(user_id, status, is_test) VALUES (owner_id, 'bidding', true) RETURNING id INTO c;
  INSERT INTO fx VALUES ('claim', c);
  INSERT INTO public.claims(user_id, status, is_test) VALUES (owner_id, 'draft', true) RETURNING id INTO cd;
  INSERT INTO fx VALUES ('claim_draft', cd);
  INSERT INTO public.contractors(user_id, company_name, contact_name, email, is_test, has_payment_method, stripe_payment_method_id, stripe_payment_method_last4, status) VALUES (gen_random_uuid(), 'Proof A', 'A', 'a@example.invalid', true, true, 'pm_proof_a', '4242', 'active') RETURNING id INTO v_k; INSERT INTO fx VALUES ('kA', v_k); INSERT INTO fx SELECT 'uA', user_id FROM public.contractors WHERE id = v_k;
  INSERT INTO public.contractors(user_id, company_name, contact_name, email, is_test, has_payment_method, stripe_payment_method_id, stripe_payment_method_last4, status) VALUES (gen_random_uuid(), 'Proof B', 'B', 'b@example.invalid', true, true, 'pm_proof_b', '4242', 'active') RETURNING id INTO v_k; INSERT INTO fx VALUES ('kB', v_k);
  INSERT INTO public.contractors(user_id, company_name, contact_name, email, is_test, has_payment_method, status) VALUES (gen_random_uuid(), 'Proof C', 'C', 'c@example.invalid', true, false, 'active') RETURNING id INTO v_k; INSERT INTO fx VALUES ('kC', v_k);
  INSERT INTO public.contractors(user_id, company_name, contact_name, email, is_test, has_payment_method, stripe_payment_method_id, stripe_payment_method_last4, status) VALUES (gen_random_uuid(), 'Proof E', 'E', 'e@example.invalid', true, true, 'pm_proof_e', '4242', 'active') RETURNING id INTO v_k; INSERT INTO fx VALUES ('kE', v_k);
  INSERT INTO public.quotes(claim_id, contractor_id, total_price, fee_percentage, fee_amount, status, bid_status, is_test) VALUES (c, (SELECT v FROM fx WHERE k='kA'), 1000, 5, 50, 'submitted', 'active', true) RETURNING id INTO v_q; INSERT INTO fx VALUES ('qA', v_q);
  INSERT INTO public.quotes(claim_id, contractor_id, total_price, fee_percentage, fee_amount, status, bid_status, is_test) VALUES (c, (SELECT v FROM fx WHERE k='kC'), 900, 5, 45, 'submitted', 'active', true) RETURNING id INTO v_q; INSERT INTO fx VALUES ('qC', v_q);
  INSERT INTO public.quotes(claim_id, contractor_id, total_price, fee_percentage, fee_amount, status, bid_status, is_test) VALUES (c, (SELECT v FROM fx WHERE k='kE'), 800, 5, 40, 'submitted', 'expired', true) RETURNING id INTO v_q; INSERT INTO fx VALUES ('qE', v_q);
  INSERT INTO public.quotes(claim_id, contractor_id, total_price, fee_percentage, fee_amount, status, bid_status, is_test) VALUES (cd, (SELECT v FROM fx WHERE k='kA'), 1000, 5, 50, 'submitted', 'active', true) RETURNING id INTO v_q; INSERT INTO fx VALUES ('qAd', v_q);
END $fix$;
CREATE FUNCTION pg_temp.fx(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM fx WHERE k = p $$;
CREATE FUNCTION pg_temp.reset() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.claims SET status = 'bidding', selected_contractor_id = NULL, selected_bid_amount = NULL WHERE id = pg_temp.fx('claim');
  UPDATE public.claims SET status = 'draft', selected_contractor_id = NULL, selected_bid_amount = NULL WHERE id = pg_temp.fx('claim_draft');
  UPDATE public.quotes SET status = 'submitted', bid_status = 'active' WHERE id IN (pg_temp.fx('qA'), pg_temp.fx('qC'), pg_temp.fx('qAd'));
  UPDATE public.quotes SET status = 'submitted', bid_status = 'expired' WHERE id = pg_temp.fx('qE');
END $$;
-- att: run one SQL text as a role, log the outcome and the claim's resulting award columns, then reset
CREATE FUNCTION pg_temp.att(p_label text, p_role text, p_sub uuid, p_email text, p_sql text, p_claim text DEFAULT 'claim') RETURNS void LANGUAGE plpgsql AS $$
DECLARE n int; res text; st text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    res := 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    res := 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 100);
  END;
  SELECT format('status=%s selected=%s amount=%s', status, coalesce((SELECT company_name FROM public.contractors WHERE id = selected_contractor_id), 'NULL'), coalesce(selected_bid_amount::text, 'NULL')) INTO st FROM public.claims WHERE id = pg_temp.fx(p_claim);
  INSERT INTO proof_log(line) VALUES (p_label || ': ' || res || ' | claim now ' || st);
  PERFORM pg_temp.reset();
END $$;

-- seq2: two writes in a row as the same caller (revive a quote, then try to award it), logged on one line
CREATE FUNCTION pg_temp.seq2(p_label text, p_role text, p_sub uuid, p_email text, p_sql1 text, p_sql2 text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r1 text; r2 text; st text;
BEGIN
  r1 := pg_temp.try_as(p_role, p_sub, p_email, p_sql1);
  r2 := pg_temp.try_as(p_role, p_sub, p_email, p_sql2);
  SELECT format('status=%s selected=%s amount=%s', status, coalesce((SELECT company_name FROM public.contractors WHERE id = selected_contractor_id), 'NULL'), coalesce(selected_bid_amount::text, 'NULL')) INTO st FROM public.claims WHERE id = pg_temp.fx('claim');
  INSERT INTO proof_log(line) VALUES (p_label || ': ' || r1 || ' ; then ' || r2 || ' | claim now ' || st);
  PERFORM pg_temp.reset();
END $$;

UPDATE public.contractors SET has_payment_method = true, stripe_payment_method_id = 'pm_proof_c', stripe_payment_method_last4 = '4242' WHERE id = pg_temp.fx('kC');
INSERT INTO proof_log(line) VALUES ('GUARDS quotes guard carries gh-2626: ' || (SELECT position('gh-2626' IN prosrc) > 0 FROM pg_proc WHERE oid = to_regprocedure('public.quotes_guard_homeowner_columns()'))
  || ' | accept_bid carries gh-2626: ' || (SELECT position('gh-2626' IN prosrc) > 0 FROM pg_proc WHERE oid = to_regprocedure('public.accept_bid(uuid,uuid)'))
  || ' | claims_guard_award_columns trigger: ' || EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.claims'::regclass AND tgname='claims_guard_award_columns' AND NOT tgisinternal)
  || ' | gh-2519 fee function: ' || (to_regprocedure('public.quotes_platform_fee_for(uuid,uuid)') IS NOT NULL)
  || ' | gh-2564 lock: ' || (SELECT position('gh-2564' IN prosrc) > 0 FROM pg_proc WHERE oid = to_regprocedure('public.quotes_guard_homeowner_columns()')));

CREATE FUNCTION pg_temp.qs(p text) RETURNS text LANGUAGE sql AS $$
  SELECT format('%s=%s/%s', p, status, bid_status) FROM public.quotes WHERE id = pg_temp.fx(p) $$;
CREATE FUNCTION pg_temp.cl() RETURNS text LANGUAGE sql AS $$
  SELECT format('claim status=%s selected=%s amount=%s', status, coalesce((SELECT company_name FROM public.contractors WHERE id = selected_contractor_id), 'NULL'), coalesce(selected_bid_amount::text, 'NULL'))
    FROM public.claims WHERE id = pg_temp.fx('claim') $$;

-- fixture for C1, C2, C4: the claim is back in bidding with no selected contractor, and kA's bid is still status selected (switch-contractor's refused 'cancelled' write)
UPDATE public.quotes SET status = 'selected' WHERE id = pg_temp.fx('qA');
INSERT INTO proof_log(line) VALUES ('C1 OWNER direct UPDATE quotes SET status = selected on kC''s submitted bid qC, while the switched-away qA is still selected (the gh-2519 clean-up declines qA): '
  || pg_temp.try_as('authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.quotes SET status = ''selected'' WHERE id = %L', pg_temp.fx('qC')))
  || ' -> ' || pg_temp.qs('qA') || ' ' || pg_temp.qs('qC'));
UPDATE public.quotes SET status = 'submitted', bid_status = 'active' WHERE id = pg_temp.fx('qC');
UPDATE public.quotes SET status = 'selected', bid_status = 'active' WHERE id = pg_temp.fx('qA');
INSERT INTO proof_log(line) VALUES ('C2 OWNER rpc accept_bid(claim, qC) while the switched-away qA is still selected: '
  || pg_temp.try_as('authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('SELECT * FROM public.accept_bid(%L, %L)', pg_temp.fx('claim'), pg_temp.fx('qC')))
  || ' -> ' || pg_temp.qs('qA') || ' ' || pg_temp.qs('qC') || ' | ' || pg_temp.cl());
UPDATE public.quotes SET status = 'submitted', bid_status = 'active' WHERE id = pg_temp.fx('qC');
UPDATE public.quotes SET status = 'selected', bid_status = 'active' WHERE id = pg_temp.fx('qA');
UPDATE public.claims SET status = 'bidding', selected_contractor_id = NULL, selected_bid_amount = NULL WHERE id = pg_temp.fx('claim');
INSERT INTO proof_log(line) VALUES ('C4 OWNER rpc accept_bid(claim, qA), the switched-away selected bid (review 6155821752 B1): '
  || pg_temp.try_as('authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('SELECT * FROM public.accept_bid(%L, %L)', pg_temp.fx('claim'), pg_temp.fx('qA')))
  || ' -> ' || pg_temp.qs('qA') || ' | ' || pg_temp.cl());
-- C3: a signed claim with the live winner; a repeated accept of the winner writes nothing
UPDATE public.quotes SET status = 'selected', bid_status = 'active' WHERE id = pg_temp.fx('qA');
UPDATE public.claims SET status = 'contract_signed', selected_contractor_id = pg_temp.fx('kA'), selected_bid_amount = 1000 WHERE id = pg_temp.fx('claim');
INSERT INTO proof_log(line) VALUES ('C3 OWNER rpc accept_bid(claim, qA), the live winner, on a contract_signed claim (a repeated click): '
  || pg_temp.try_as('authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('SELECT * FROM public.accept_bid(%L, %L)', pg_temp.fx('claim'), pg_temp.fx('qA')))
  || ' -> ' || pg_temp.qs('qA') || ' | ' || pg_temp.cl());

SELECT line FROM proof_log ORDER BY n;
ROLLBACK;
