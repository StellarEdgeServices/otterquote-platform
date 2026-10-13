-- gh-2626 proof: the claims award-columns guard. Run on a THROWAWAY Postgres only
-- (supabase/tests/gh2626_claims_award_columns_guard_proof_run.sh does it); never point it at production.
-- The schema is supabase/tests/gh2519_gh2564_throwaway_schema.sql (production's claims, quotes, contractors, their
-- policies, guards and accept_bid() as read 2026-10-08). One transaction that ends in ROLLBACK and prints one line
-- per attempt. The runner executes it six times (TODAY, GUARD-ONLY, ..., see the runner) so that the direct write is
-- shown succeeding before and refused after, with and without PR #2623's payment-guard fix.
-- Every attempt runs as role authenticated (or service_role) with a JWT sub in its own exception block. Fixtures are
-- inserted as the table owner and carry is_test = true. Contractors: kA has a payment method and a live bid of
-- 1000 on the claim; kC has a live bid of 900 and NO payment method; kB has a payment method and NO bid; kE has a
-- payment method and an EXPIRED bid of 800.
-- Review 6155135164 (F1/F2) lines: W1 to W4 are the owner's accept_bid() calls (expired bid, contract_signed claim, draft
-- claim, withdrawn bid), V1 to V4 the owner reviving a quote through the quotes UPDATE policy and then awarding it; Q1/S2
-- are the contractor's own and service_role's quote writes, which must stay accepted; R7 is accept_bid() on an active claim.
-- Review 6155821752 (B1/B2) lines: Z2/Z3 re-award a switched-away (selected, refunded) quote through accept_bid() and a direct write; Z6 relabels a
-- draft quote declined and then accepts it. ACCEPTED before, REJECTED after.
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

INSERT INTO proof_log(line) VALUES ('GUARD claims_guard_award_columns present: ' || EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.claims'::regclass AND tgname='claims_guard_award_columns' AND NOT tgisinternal));
INSERT INTO proof_log(line) VALUES ('PAYMENT-GUARD claims_enforce_payment_method_on_award prosecdef (true once #2623 is applied): ' || (SELECT prosecdef FROM pg_proc WHERE oid='public.claims_enforce_payment_method_on_award'::regproc));
INSERT INTO proof_log(line) VALUES (format('FIXTURE claim is_test=%s status=%s | kA bids 1000 (payment method yes) | kC bids 900 (no payment method) | kB no bid (yes) | kE expired bid 800 (yes)', (SELECT is_test FROM claims WHERE id = pg_temp.fx('claim')), (SELECT status FROM claims WHERE id = pg_temp.fx('claim'))));

-- Direct writes by the claim owner that must be REFUSED after the guard (the defect, ACCEPTED before it)
SELECT pg_temp.att('D1 owner sets selected_contractor_id = kB, who never bid (column only)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.claims SET selected_contractor_id = %L WHERE id = %L', pg_temp.fx('kB'), pg_temp.fx('claim')));
SELECT pg_temp.att('D2 owner awards kB, who never bid, any amount (5)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 5, status = ''awarded'' WHERE id = %L', pg_temp.fx('kB'), pg_temp.fx('claim')));
SELECT pg_temp.att('D3 owner awards kA, who bid 1000, at an amount nobody quoted (1)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 1, status = ''awarded'' WHERE id = %L', pg_temp.fx('kA'), pg_temp.fx('claim')));
SELECT pg_temp.att('D4 owner awards kE, whose only bid is expired', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 800, status = ''awarded'' WHERE id = %L', pg_temp.fx('kE'), pg_temp.fx('claim')));
SELECT pg_temp.att('D5 owner awards kA at the right amount from status draft (not open for bids)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 1000, status = ''awarded'' WHERE id = %L', pg_temp.fx('kA'), pg_temp.fx('claim_draft')), 'claim_draft');
-- D6 to D8 fixture: the claim is put in contract_signed first, as the table owner, before each attempt
UPDATE public.claims SET status = 'contract_signed', selected_contractor_id = pg_temp.fx('kA'), selected_bid_amount = 1000 WHERE id = pg_temp.fx('claim');
SELECT pg_temp.att('D6 owner moves a contract_signed claim back to active', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.claims SET status = ''active'' WHERE id = %L', pg_temp.fx('claim')));
UPDATE public.claims SET status = 'contract_signed', selected_contractor_id = pg_temp.fx('kA'), selected_bid_amount = 1000 WHERE id = pg_temp.fx('claim');
SELECT pg_temp.att('D7 owner awards the contract_signed claim again (status awarded)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.claims SET status = ''awarded'' WHERE id = %L', pg_temp.fx('claim')));
UPDATE public.claims SET status = 'contract_signed', selected_contractor_id = pg_temp.fx('kA'), selected_bid_amount = 1000 WHERE id = pg_temp.fx('claim');
SELECT pg_temp.att('D8 owner repoints a contract_signed claim at kB, who never bid', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.claims SET selected_contractor_id = %L WHERE id = %L', pg_temp.fx('kB'), pg_temp.fx('claim')));
UPDATE public.claims SET status = 'bidding', selected_contractor_id = NULL, selected_bid_amount = NULL WHERE id = pg_temp.fx('claim');

-- Writes the app does, which must stay ACCEPTED after the guard
SELECT pg_temp.att('R1 React award: kA, amount 1000 = the bid, status awarded (actions.ts shape; needs #2623 to pass the payment guard)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 1000, status = ''awarded'' WHERE id = %L', pg_temp.fx('kA'), pg_temp.fx('claim')));
SELECT pg_temp.att('R2 React award to kC, who bid 900 but has no payment method (must stay refused by the payment guard, P0001)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 900, status = ''awarded'' WHERE id = %L', pg_temp.fx('kC'), pg_temp.fx('claim')));
SELECT pg_temp.att('R3 bids.html award: accept_bid(claim, quote of kA) RPC', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('SELECT * FROM public.accept_bid(%L, %L)', pg_temp.fx('claim'), pg_temp.fx('qA')));
SELECT pg_temp.att('R4 owner waitlists the claim (dashboard write, no award column)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.claims SET status = ''waitlisted'' WHERE id = %L', pg_temp.fx('claim')));
UPDATE public.claims SET status = 'awarded', selected_contractor_id = pg_temp.fx('kA'), selected_bid_amount = 1000 WHERE id = pg_temp.fx('claim');
SELECT pg_temp.att('R5 owner re-sends the same award columns unchanged on an awarded claim (a save that carries them)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 1000, status = ''awarded'', property_address = ''1 Proof St'' WHERE id = %L', pg_temp.fx('kA'), pg_temp.fx('claim')));
UPDATE public.claims SET status = 'bidding', selected_contractor_id = NULL, selected_bid_amount = NULL WHERE id = pg_temp.fx('claim');
SELECT pg_temp.att('S1 service_role sets the selected contractor to kB (switch-contractor style Edge Function write)', 'service_role', NULL, NULL, format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 5 WHERE id = %L', pg_temp.fx('kB'), pg_temp.fx('claim')));
SELECT pg_temp.att('A1 admin session awards kB without a bid', 'authenticated', pg_temp.fx('other'), 'dustinstohler1@gmail.com', format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 5, status = ''awarded'' WHERE id = %L', pg_temp.fx('kB'), pg_temp.fx('claim')));
SELECT pg_temp.att('X1 a stranger tries the same direct write on the owner''s claim (RLS: no row)', 'authenticated', pg_temp.fx('other'), 'stranger@example.invalid', format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 5, status = ''awarded'' WHERE id = %L', pg_temp.fx('kB'), pg_temp.fx('claim')));

-- F1 (review 6155135164): the owner's accept_bid() calls. ACCEPTED today (and after #2623 alone), REJECTED P0001 after.
SELECT pg_temp.att('W1 owner calls accept_bid on kE''s expired bid (bid_status expired)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('SELECT * FROM public.accept_bid(%L, %L)', pg_temp.fx('claim'), pg_temp.fx('qE')));
UPDATE public.claims SET status = 'contract_signed', selected_contractor_id = pg_temp.fx('kA'), selected_bid_amount = 1000 WHERE id = pg_temp.fx('claim');
SELECT pg_temp.att('W2 owner calls accept_bid(kA live bid) on a contract_signed claim (un-sign)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('SELECT * FROM public.accept_bid(%L, %L)', pg_temp.fx('claim'), pg_temp.fx('qA')));
UPDATE public.claims SET status = 'bidding', selected_contractor_id = NULL, selected_bid_amount = NULL WHERE id = pg_temp.fx('claim');
SELECT pg_temp.att('W3 owner calls accept_bid on a draft claim', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('SELECT * FROM public.accept_bid(%L, %L)', pg_temp.fx('claim_draft'), pg_temp.fx('qAd')), 'claim_draft');
UPDATE public.quotes SET bid_status = 'cancelled' WHERE id = pg_temp.fx('qA');
SELECT pg_temp.att('W4 owner calls accept_bid on kA''s withdrawn bid (bid_status cancelled)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('SELECT * FROM public.accept_bid(%L, %L)', pg_temp.fx('claim'), pg_temp.fx('qA')));

-- F2: the owner revives a quote through the quotes UPDATE policy, then awards it. ACCEPTED today, REJECTED after (both steps)
SELECT pg_temp.seq2('V1 owner sets qE.bid_status=active, then awards kE at 800', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid',
  format('UPDATE public.quotes SET bid_status = ''active'' WHERE id = %L', pg_temp.fx('qE')),
  format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 800, status = ''awarded'' WHERE id = %L', pg_temp.fx('kE'), pg_temp.fx('claim')));
UPDATE public.quotes SET bid_status = 'cancelled', status = 'declined' WHERE id = pg_temp.fx('qA');
SELECT pg_temp.seq2('V2 kA bid withdrawn+declined; owner sets bid_status=active,status=selected, then awards kA at 1000', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid',
  format('UPDATE public.quotes SET bid_status = ''active'', status = ''selected'' WHERE id = %L', pg_temp.fx('qA')),
  format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 1000, status = ''awarded'' WHERE id = %L', pg_temp.fx('kA'), pg_temp.fx('claim')));
UPDATE public.quotes SET status = 'declined' WHERE id = pg_temp.fx('qA');
SELECT pg_temp.seq2('V3 owner moves a declined (bid_status active) quote back to selected, then awards it', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid',
  format('UPDATE public.quotes SET status = ''selected'' WHERE id = %L', pg_temp.fx('qA')),
  format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 1000, status = ''awarded'' WHERE id = %L', pg_temp.fx('kA'), pg_temp.fx('claim')));
UPDATE public.quotes SET bid_status = 'cancelled' WHERE id = pg_temp.fx('qA');
SELECT pg_temp.seq2('V4 kA bid withdrawn (status still submitted); owner sets status=selected only, then awards it', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid',
  format('UPDATE public.quotes SET status = ''selected'' WHERE id = %L', pg_temp.fx('qA')),
  format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 1000, status = ''awarded'' WHERE id = %L', pg_temp.fx('kA'), pg_temp.fx('claim')));

-- Review 6155821752: B1 (Z2, Z3) a switched-away, refunded 'selected' quote re-awarded; B2 (Z6) a never-submitted draft relabelled declined, then accepted.
-- switch-contractor's quotes.status='cancelled' write fails quotes_status_check, so the switched-away quote stays selected / active / refunded.
-- ACCEPTED today (and after #2623 alone), REJECTED after.
UPDATE public.claims SET status = 'bidding', selected_contractor_id = NULL, selected_bid_amount = NULL WHERE id = pg_temp.fx('claim');
UPDATE public.quotes SET status = 'selected', bid_status = 'active', payment_status = 'refunded' WHERE id = pg_temp.fx('qA');
SELECT pg_temp.att('Z2 after a switch, owner calls accept_bid on the switched-away (selected, refunded) quote of kA', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('SELECT * FROM public.accept_bid(%L, %L)', pg_temp.fx('claim'), pg_temp.fx('qA')));
UPDATE public.quotes SET status = 'selected', bid_status = 'active', payment_status = 'refunded' WHERE id = pg_temp.fx('qA');
SELECT pg_temp.att('Z3 after a switch, owner direct-awards kA at 1000 (the switched-away, selected, refunded quote)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.claims SET selected_contractor_id = %L, selected_bid_amount = 1000, status = ''awarded'' WHERE id = %L', pg_temp.fx('kA'), pg_temp.fx('claim')));
UPDATE public.quotes SET status = 'submitted', bid_status = 'active', payment_status = NULL WHERE id = pg_temp.fx('qA');
INSERT INTO public.quotes(claim_id, contractor_id, total_price, fee_percentage, fee_amount, status, bid_status, is_test) VALUES (pg_temp.fx('claim'), pg_temp.fx('kB'), 700, 5, 35, 'draft', 'active', true);
INSERT INTO fx SELECT 'qB', id FROM public.quotes WHERE claim_id = pg_temp.fx('claim') AND contractor_id = pg_temp.fx('kB');
SELECT pg_temp.seq2('Z6 owner relabels kB''s DRAFT (never submitted) quote declined, then accept_bid on it', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid',
  format('UPDATE public.quotes SET status = ''declined'' WHERE id = %L', pg_temp.fx('qB')),
  format('SELECT * FROM public.accept_bid(%L, %L)', pg_temp.fx('claim'), pg_temp.fx('qB')));
DELETE FROM public.quotes WHERE id = pg_temp.fx('qB');
DELETE FROM fx WHERE k = 'qB';

-- Paths that must stay ACCEPTED after the new rules
UPDATE public.claims SET status = 'active' WHERE id = pg_temp.fx('claim');
SELECT pg_temp.att('R7 owner calls accept_bid on a live bid of an ACTIVE claim (the other awardable status)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('SELECT * FROM public.accept_bid(%L, %L)', pg_temp.fx('claim'), pg_temp.fx('qA')));
SELECT pg_temp.att('Q1 the bidding contractor (kA) changes its own bid_status to superseded (contractor path, untouched)', 'authenticated', pg_temp.fx('uA'), 'a@example.invalid', format('UPDATE public.quotes SET bid_status = ''superseded'' WHERE id = %L', pg_temp.fx('qA')));
SELECT pg_temp.att('S2 service_role sets kE''s bid_status to active (process-bid-expirations / rescind-bid style write, untouched)', 'service_role', NULL, NULL, format('UPDATE public.quotes SET bid_status = ''active'' WHERE id = %L', pg_temp.fx('qE')));
SELECT pg_temp.att('R8 owner selects a submitted, active bid (the quote step of the React award)', 'authenticated', pg_temp.fx('owner'), 'owner@example.invalid', format('UPDATE public.quotes SET status = ''selected'' WHERE id = %L', pg_temp.fx('qA')));

-- Whole React sequence (claim, winning quote, decline the others) for the app-award-still-succeeds line.
-- B4 (6156232136; DECIDED 6156405895): the claim also has a sibling quote with status 'expired' (qE, relabelled
-- here) and a sibling DRAFT quote (kB), as the common real case. R6b runs the OLD unfiltered decline-others
-- statement (negative control: REJECTED 42501 once the guard is applied, ACCEPTED before); R6 runs the sequence
-- with the fixed statement (status = 'submitted' filter, react-app/app/(homeowner)/bids/actions.ts) and must be ACCEPTED.
DO $seq$
DECLARE a text; b text; c text; st text; sib text; ub text;
  v_owner uuid := pg_temp.fx('owner'); v_claim uuid := pg_temp.fx('claim'); v_kA uuid := pg_temp.fx('kA'); v_qA uuid := pg_temp.fx('qA');
  v_qE uuid := pg_temp.fx('qE'); v_qD uuid;
BEGIN
  UPDATE public.quotes SET status = 'expired', bid_status = 'expired' WHERE id = v_qE;
  INSERT INTO public.quotes(claim_id, contractor_id, total_price, fee_percentage, fee_amount, status, bid_status, is_test) VALUES (v_claim, pg_temp.fx('kB'), 700, 5, 35, 'draft', 'active', true) RETURNING id INTO v_qD;
  -- R6b: old unfiltered statement (React L153 before the fix), rolled back by a sentinel exception either way
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'email', 'owner@example.invalid')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    UPDATE public.quotes SET status = 'declined' WHERE claim_id = v_claim AND id <> v_qA;
    ub := 'unfiltered decline-others ACCEPTED';
    RAISE EXCEPTION 'rollback-r6b' USING ERRCODE = 'ZZ999';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'ZZ999' THEN ub := 'unfiltered decline-others REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 90); END IF;
  END;
  EXECUTE 'RESET ROLE';
  INSERT INTO proof_log(line) VALUES ('R6b old unfiltered decline-others with a sibling expired quote and a sibling draft quote: ' || ub);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'email', 'owner@example.invalid')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    UPDATE public.claims SET selected_contractor_id = v_kA, selected_bid_amount = 1000, status = 'awarded' WHERE id = v_claim;
    a := 'claim ACCEPTED';
    UPDATE public.quotes SET status = 'selected' WHERE id = v_qA;
    b := 'winning quote ACCEPTED';
    UPDATE public.quotes SET status = 'declined' WHERE claim_id = v_claim AND id <> v_qA AND status = 'submitted';
    c := 'decline others (submitted only) ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    a := coalesce(a, 'claim REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 90));
    IF b IS NOT NULL AND c IS NULL THEN c := 'decline others REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 90); END IF;
  END;
  EXECUTE 'RESET ROLE';
  SELECT format('claim status=%s', status) INTO st FROM public.claims WHERE id = v_claim;
  SELECT string_agg(format('%s=%s', x.k, q.status), ',' ORDER BY x.k) INTO sib FROM public.quotes q JOIN (VALUES ('qA', v_qA), ('qC', pg_temp.fx('qC')), ('qE', v_qE), ('qD', v_qD)) AS x(k, id) ON x.id = q.id;
  INSERT INTO proof_log(line) VALUES ('R6 full React sequence: ' || concat_ws(' | ', a, b, c, st) || ' | quote statuses after: ' || sib);
END $seq$;

SELECT line FROM proof_log ORDER BY n;
ROLLBACK;
