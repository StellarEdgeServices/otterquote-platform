-- gh-2479 proof: born-state guard on claims and quotes
-- (migration 20261005200000_gh2479_born_state_guard.sql; CLOSE-REVIEW: FAIL #2479 comment 6000637783).
-- Run against production (yeszghaspzwwstvsrioa) in ONE statement batch that is forced to roll back.
--   BEFORE the fix : run this file alone.
--   AFTER the fix, not yet applied : replace the final DO block with one DO block that (1) calls
--                    pg_temp.gh2479_born_scenario(), (2) EXECUTEs the migration body with its BEGIN; and
--                    COMMIT; lines removed, (3) calls the scenario again, (4) EXECUTEs the rollback file
--                    the same way, (5) calls it a third time, and (6) raises all three texts. The DDL
--                    then runs inside the one statement that is forced to fail, so it cannot commit
--                    whatever the client does with a multi-statement batch. That is how the PR's proof
--                    was produced (pre-flight note, "Proof").
--   AFTER the fix, applied : run this file alone again.
-- The last statement is a deliberate RAISE EXCEPTION, so everything the scenario writes rolls back; the
-- raw findings are the exception text. Each group runs inside its own savepoint (a block that
-- raises P0U01 and catches it), and each line of a matrix (X, Y, Q) is undone on its own, so no write
-- feeds a later line unless the group says so.
-- Roles are set the way PostgREST sets them (role + request.jwt.claims), and both are cleared after each
-- statement, so the superuser fixture lines never run under a leftover claim set. New rows use fixed ids in the
-- 00000000-2479-4c00-8000-* range so that the output is identical from run to run.
-- Everything touched is is_test (the FIXTURES line prints it): homeowner f6c14b57 and its claims,
-- contractors 986ce2b6 (k1, login d4def812) and bb07fc40 (k2, login 189b85ad), quote ff1f8323, referral
-- 770c7bd8. Three fixtures are set by the superuser inside the transaction and roll back with it: k1 and
-- k2 get a validated roofing/retail contract template (so the D-199 bid gate lets a bid through) and k1
-- gets a payment method on file (has_payment_method = true with a placeholder Stripe id and last4, which
-- contractors_has_payment_method_requires_verified_method demands), so the gh-1532 award guard lets an
-- award through. A contractor cannot set those three columns themselves
-- (enforce_contractor_privileged_columns()).
--
-- pg_temp.mjc() stands in for the mark-job-complete Edge Function. It applies the function's own two
-- checks at main (supabase/functions/mark-job-complete/index.ts: the caller's contractor has exactly one
-- quote on the claim with status selected/awarded, ~L315; the claim is 'contract_signed' or 'awarded',
-- COMPLETABLE_STATES L52) and then makes its one write, completion_date, as service_role (~L376).
--
-- Expected BEFORE (the holes): E1, E7, E3, E3u end in commission=200.00; X2, X4-X8, X10-X14 ACCEPTED;
--   Y2, Y5-Y8, Y11 ACCEPTED; Q2-Q13, Q17 ACCEPTED.
-- Expected AFTER: E1, E7, E3, E3u end in commission=null and payout_approvals rows=0; those X, Y and Q
--   lines REJECTED 42501.
-- Expected the SAME before and after:
--   X0, X1, X3 (the funnel's own INSERT, with status omitted, 'documents_needed', 'draft');
--   X9 REJECTED both times (23514 claims_status_check before, this guard's 42501 after: the BEFORE
--     trigger fires ahead of the CHECK constraint); X15, X16 (RLS);
--   Y1, Y3, Y4 ACCEPTED (active, waitlisted, submitted); Y9, Y10, Y12, Y13 ACCEPTED;
--   Y-awarded: the React award's claims write, refused P0001 contractor_no_payment_method both times
--     (existing defect: claims_enforce_payment_method_on_award() reads public.contractors as the
--     homeowner, who cannot SELECT it);
--   Q0, Q1 ACCEPTED; Q14, Q15 REJECTED both times (RLS before, this guard after: the BEFORE trigger fires
--     ahead of the policy check, so the message changes and the outcome does not); Q16 permission denied;
--   every L line (the legitimate flow, client payload shapes) and its commission=200.00;
--   every R line (React award); every S line (service_role, admin). S4 is refused 23502 both times: the
--     auto-renew INSERT in process-bid-expirations sends no fee_percentage, which is NOT NULL (existing
--     defect on a service_role path, not this guard; S4b is the same INSERT with the fee columns).
-- NOT closed by this migration, printed so nobody has to guess (see the pre-flight "Residual"):
--   E3p and E3q end in commission=200.00 before AND after. One user who is both the claim owner and an
--   active contractor with a payment method on file can take a claim through the product's own award
--   (accept_bid() or the React award) to 'awarded', which mark-job-complete accepts.

CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_sql text, p_email text DEFAULT 'gh2479-born-proof@example.invalid') RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_role = 'anon' THEN json_build_object('role', 'anon')::text
    ELSE json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text END, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row changed)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;
END $f$;

-- same as try_as, but the statement's own effect is undone before returning (for the matrices)
CREATE FUNCTION pg_temp.probe_as(p_role text, p_sub uuid, p_sql text, p_email text DEFAULT 'gh2479-born-proof@example.invalid') RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
  BEGIN
    r := pg_temp.try_as(p_role, p_sub, p_sql, p_email);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U02';
  EXCEPTION WHEN SQLSTATE 'P0U02' THEN NULL;
  END;
  RETURN r;
END $f$;

CREATE FUNCTION pg_temp.q_as(p_role text, p_sub uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role, 'email', 'gh2479-born-proof@example.invalid')::text, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql INTO v;
    EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
    RETURN COALESCE(v, 'NULL');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;
END $f$;

CREATE FUNCTION pg_temp.acc(p_ref uuid) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE r record; n int; s numeric; t text;
BEGIN
  SELECT status, commission_amount INTO r FROM public.referrals WHERE id = p_ref;
  SELECT count(*), COALESCE(sum(amount), 0), string_agg(DISTINCT is_test::text, ',')
    INTO n, s, t FROM public.payout_approvals WHERE referral_id = p_ref;
  RETURN format('referral %s status=%s commission=%s | payout_approvals rows=%s sum=%s is_test=%s',
                left(p_ref::text, 8), r.status, COALESCE(r.commission_amount::text, 'null'), n, s, COALESCE(t, '-'));
END $f$;

-- mark-job-complete, as the Edge Function decides it (see the header)
CREATE FUNCTION pg_temp.mjc(p_claim uuid, p_contractor uuid) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int; c record;
BEGIN
  SELECT count(*) INTO n FROM public.quotes
   WHERE claim_id = p_claim AND contractor_id = p_contractor AND status IN ('selected', 'awarded');
  IF n = 0 THEN RETURN 'mark-job-complete: REFUSES 403 (no won quote of this contractor on the claim)'; END IF;
  IF n > 1 THEN RETURN 'mark-job-complete: REFUSES 500 (more than one won quote)'; END IF;
  SELECT status, completion_date INTO c FROM public.claims WHERE id = p_claim;
  IF NOT FOUND THEN RETURN 'mark-job-complete: REFUSES 404 (claim not found)'; END IF;
  IF c.completion_date IS NOT NULL THEN RETURN 'mark-job-complete: already complete, no write'; END IF;
  IF c.status IS NULL OR c.status NOT IN ('contract_signed', 'awarded') THEN
    RETURN format('mark-job-complete: REFUSES 409 (claim status %s)', COALESCE(c.status, 'NULL'));
  END IF;
  RETURN 'mark-job-complete: COMPLETES, ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.claims SET completion_date=now() WHERE id=%L', p_claim));
END $f$;

CREATE FUNCTION pg_temp.gh2479_born_scenario() RETURNS text
LANGUAGE plpgsql AS $s$
DECLARE
  o    constant uuid := 'f6c14b57-59dc-43ce-b510-04277a71f5af'; -- is_test homeowner
  stranger constant uuid := '6a9ec731-85d4-4076-ae99-bc77829ee393'; -- another is_test homeowner
  c1   constant uuid := '4d764e19-0549-43db-a967-9ab564f05f23'; -- o's claim, awarded
  q1   constant uuid := 'ff1f8323-1e74-43d6-a6b4-116b940dfa65'; -- selected 13560 on c1, contractor k1
  csig constant uuid := '6aea8081-a3a3-4a22-a1a8-1becb7fedcb6'; -- o's claim, contract_signed
  cbid constant uuid := '374a2053-de6c-4f9a-9974-2e22714a4795'; -- o's claim, bidding
  k1   constant uuid := '986ce2b6-39fd-4a2c-aba4-a806c618c8c0'; k1u constant uuid := 'd4def812-aebc-444c-bdee-f68bccc19b61';
  k2   constant uuid := 'bb07fc40-3607-4f3f-ac44-dffd4ca95111'; k2u constant uuid := '189b85ad-0ab0-4e54-9083-c51c3ef42a1d';
  rx   constant uuid := '770c7bd8-532b-4f75-8a82-dfca275fcd98'; -- another agent's is_test referral, inside the window
  admin_email constant text := 'dustin@otterquote.com';         -- one of the two is_admin_email() addresses
  ca   constant uuid := '00000000-2479-4c00-8000-00000000000a'; -- new claims (fixed ids, see header)
  cb   constant uuid := '00000000-2479-4c00-8000-00000000000b';
  qa   constant uuid := '00000000-2479-4c00-8000-0000000000a1'; -- new quotes
  qb   constant uuid := '00000000-2479-4c00-8000-0000000000a2';
  v text := '';
  bid_cols constant text := 'claim_id,contractor_id,total_price,fee_percentage,fee_amount,is_test,trade_type';
  bid_vals text;
  funnel_static text; funnel_react text; client_bid text; s text;
BEGIN
  -- fixtures (superuser, roll back with the batch)
  UPDATE public.contractor_templates SET status = 'admin_validated'
   WHERE contractor_id IN (k1, k2) AND lower(trade) = 'roofing' AND lower(funding_type) = 'retail';
  UPDATE public.contractors SET stripe_payment_method_id = 'pm_gh2479_proof_fixture', stripe_payment_method_last4 = '4242', has_payment_method = true WHERE id = k1;

  v := v || E'\nFIXTURES ' || format('owner_is_test=%s owner_claims_all_test=%s stranger_is_test=%s claims(c1,csig,cbid)_is_test=%s q1_is_test=%s q1=%s/%s contractors(k1,k2)_is_test=%s logins(k1u,k2u)_is_test=%s rx_is_test=%s rx_agent_is_test=%s rx_status=%s rx_in_window=%s | in-transaction fixtures: k1 bid_can_submit=%s k2 bid_can_submit=%s k1 contractor_can_bid=%s k1 has_payment_method=%s | new ids free=%s',
    (SELECT is_test FROM profiles WHERE id = o), (SELECT bool_and(is_test) FROM claims WHERE user_id = o), (SELECT is_test FROM profiles WHERE id = stranger),
    (SELECT bool_and(is_test) FROM claims WHERE id IN (c1, csig, cbid)), (SELECT is_test FROM quotes WHERE id = q1),
    (SELECT status FROM quotes WHERE id = q1), (SELECT total_price FROM quotes WHERE id = q1),
    (SELECT bool_and(is_test) FROM contractors WHERE id IN (k1, k2)), (SELECT bool_and(is_test) FROM profiles WHERE id IN (k1u, k2u)),
    (SELECT is_test FROM referrals WHERE id = rx), (SELECT a.is_test FROM referral_agents a JOIN referrals r ON r.referral_agent_id = a.id WHERE r.id = rx),
    (SELECT status FROM referrals WHERE id = rx), (SELECT created_at >= now() - public.referral_attribution_window() FROM referrals WHERE id = rx),
    public.bid_can_submit(k1, 'roofing', 'retail')->>'can_submit', public.bid_can_submit(k2, 'roofing', 'retail')->>'can_submit',
    public.contractor_can_bid(k1), (SELECT has_payment_method FROM contractors WHERE id = k1),
    (SELECT count(*) = 0 FROM claims WHERE id IN (ca, cb)) AND (SELECT count(*) = 0 FROM quotes WHERE id IN (qa, qb)));
  v := v || E'\nGUARDS ' || COALESCE((SELECT string_agg(tgname::text || ' = ' || substring(pg_get_triggerdef(oid) FROM 'BEFORE [A-Z ]+ ON') || ' [' || tgenabled::text || ']', ' ; ' ORDER BY tgname)
    FROM pg_trigger WHERE tgname IN ('claims_guard_referral_columns', 'quotes_guard_homeowner_columns') AND NOT tgisinternal), '(none)');

  bid_vals := format('%L,%L,13560,5,678,true,''roofing''', ca, k1);

  -- E1: a contractor INSERTs a quote born selected on ANOTHER user's signed claim (refuter E1).
  -- Fixture (superuser): claim ca of homeowner o, contract_signed, carrying referral rx.
  BEGIN
    INSERT INTO public.claims (id, user_id, is_test, status, referral_id, job_type, funding_type) VALUES (ca, o, true, 'contract_signed', rx, 'retail', 'cash');
    v := v || E'\nE1a CONTRACTOR k1 (not the owner) INSERT quote on claim ca born status=selected, 13560: ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,status) VALUES (%L,%s,''selected'')', bid_cols, qa, bid_vals));
    v := v || E'\nE1b ' || pg_temp.mjc(ca, k1);
    v := v || E'\nE1 RESULT ' || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- E7: the same with is_auto_bid=true, which skips the D-199 bid gate (refuter E7).
  BEGIN
    INSERT INTO public.claims (id, user_id, is_test, status, referral_id, job_type, funding_type) VALUES (ca, o, true, 'contract_signed', rx, 'retail', 'cash');
    v := v || E'\nE7a CONTRACTOR k1 INSERT quote on claim ca born selected with is_auto_bid=true: ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,status,is_auto_bid) VALUES (%L,%s,''selected'',true)', bid_cols, qa, bid_vals));
    v := v || E'\nE7b ' || pg_temp.mjc(ca, k1);
    v := v || E'\nE7 RESULT ' || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- E3: one user alone, statement for statement as the refuter ran it (k1's own login).
  BEGIN
    v := v || E'\nE3a CONTRACTOR-USER k1u INSERT own claim ca (referral rx, born contract_signed): ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.claims (id,user_id,is_test,status,referral_id,job_type,funding_type) VALUES (%L,%L,true,''contract_signed'',%L,''retail'',''cash'')', ca, k1u, rx));
    v := v || E'\nE3b k1u INSERT own quote on it, status submitted, 10000: ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.quotes (id,claim_id,contractor_id,total_price,fee_percentage,fee_amount,status,is_test,trade_type) VALUES (%L,%L,%L,10000,5,500,''submitted'',true,''roofing'')', qa, ca, k1));
    v := v || E'\nE3c k1u (as claim owner) UPDATE that quote status=selected: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', qa));
    v := v || E'\nE3d ' || pg_temp.mjc(ca, k1);
    v := v || E'\nE3 RESULT ' || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- E3u: the same user goes around an INSERT-only rule: initial-state INSERT, then UPDATE the status.
  BEGIN
    v := v || E'\nE3u-a k1u INSERT own claim ca in the initial state (referral rx, status omitted): ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.claims (id,user_id,is_test,referral_id,job_type,funding_type) VALUES (%L,%L,true,%L,''retail'',''cash'')', ca, k1u, rx));
    v := v || E'\nE3u-b k1u UPDATE own claim status=contract_signed: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.claims SET status=''contract_signed'' WHERE id=%L', ca));
    v := v || E'\nE3u-c k1u INSERT own quote, status submitted, 10000: ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.quotes (id,claim_id,contractor_id,total_price,fee_percentage,fee_amount,status,is_test,trade_type) VALUES (%L,%L,%L,10000,5,500,''submitted'',true,''roofing'')', qa, ca, k1));
    v := v || E'\nE3u-d k1u (as claim owner) UPDATE that quote status=selected: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', qa));
    v := v || E'\nE3u-e ' || pg_temp.mjc(ca, k1);
    v := v || E'\nE3u RESULT ' || format('claim status=%s | ', (SELECT status FROM claims WHERE id = ca)) || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- E3p: RESIDUAL, not closed here. The same user uses only the product's own steps: create the claim
  -- from the funnel, submit it for bids, bid on it, accept the bid through accept_bid().
  BEGIN
    v := v || E'\nE3p-a k1u INSERT own claim ca in the initial state (referral rx): ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.claims (id,user_id,is_test,referral_id,job_type,funding_type) VALUES (%L,%L,true,%L,''retail'',''cash'')', ca, k1u, rx));
    v := v || E'\nE3p-b k1u submit for bids (status=active, ready_for_bids=true): ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.claims SET status=''active'', ready_for_bids=true WHERE id=%L', ca));
    v := v || E'\nE3p-c k1u INSERT own bid, 10000 (status omitted): ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.quotes (id,claim_id,contractor_id,total_price,fee_percentage,fee_amount,is_test,trade_type,is_auto_bid) VALUES (%L,%L,%L,10000,5,500,true,''roofing'',false)', qa, ca, k1));
    v := v || E'\nE3p-d k1u accept_bid(ca, own bid): ' || pg_temp.q_as('authenticated', k1u, format('SELECT ''amount='' || out_amount || '' declined='' || out_declined_count FROM public.accept_bid(%L,%L)', ca, qa));
    v := v || E'\nE3p-e ' || pg_temp.mjc(ca, k1);
    v := v || E'\nE3p RESULT (RESIDUAL) ' || format('claim status=%s | ', (SELECT status FROM claims WHERE id = ca)) || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- E3q: RESIDUAL, the same through the React award's direct writes instead of accept_bid().
  BEGIN
    v := v || E'\nE3q-a k1u INSERT own claim ca in the initial state (referral rx): ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.claims (id,user_id,is_test,referral_id,job_type,funding_type) VALUES (%L,%L,true,%L,''retail'',''cash'')', ca, k1u, rx));
    v := v || E'\nE3q-b k1u INSERT own bid, 10000: ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.quotes (id,claim_id,contractor_id,total_price,fee_percentage,fee_amount,is_test,trade_type,is_auto_bid) VALUES (%L,%L,%L,10000,5,500,true,''roofing'',false)', qa, ca, k1));
    v := v || E'\nE3q-c k1u UPDATE own claim selected_contractor_id, selected_bid_amount, status=awarded: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.claims SET selected_contractor_id=%L, selected_bid_amount=10000, status=''awarded'' WHERE id=%L', k1, ca));
    v := v || E'\nE3q-d k1u UPDATE own bid status=selected: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', qa));
    v := v || E'\nE3q-e ' || pg_temp.mjc(ca, k1);
    v := v || E'\nE3q RESULT (RESIDUAL) ' || format('claim status=%s | ', (SELECT status FROM claims WHERE id = ca)) || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- X: what a client may INSERT into claims. Homeowner o unless stated. Each line is undone on its own.
  s := 'INSERT INTO public.claims (id,user_id,is_test,job_type,funding_type';
  v := v || E'\nX0 owner INSERT claim, status omitted (what both funnels send): ' || pg_temp.probe_as('authenticated', o, format('%s) VALUES (%L,%L,true,''retail'',''cash'')', s, ca, o));
  v := v || E'\nX1 owner INSERT claim status=documents_needed: ' || pg_temp.probe_as('authenticated', o, format('%s,status) VALUES (%L,%L,true,''retail'',''cash'',''documents_needed'')', s, ca, o));
  v := v || E'\nX2 owner INSERT claim status=contract_signed: ' || pg_temp.probe_as('authenticated', o, format('%s,status) VALUES (%L,%L,true,''retail'',''cash'',''contract_signed'')', s, ca, o));
  v := v || E'\nX3 owner INSERT claim status=draft: ' || pg_temp.probe_as('authenticated', o, format('%s,status) VALUES (%L,%L,true,''retail'',''cash'',''draft'')', s, ca, o));
  v := v || E'\nX4 owner INSERT claim status=submitted: ' || pg_temp.probe_as('authenticated', o, format('%s,status) VALUES (%L,%L,true,''retail'',''cash'',''submitted'')', s, ca, o));
  v := v || E'\nX5 owner INSERT claim status=active: ' || pg_temp.probe_as('authenticated', o, format('%s,status) VALUES (%L,%L,true,''retail'',''cash'',''active'')', s, ca, o));
  v := v || E'\nX6 owner INSERT claim status=waitlisted: ' || pg_temp.probe_as('authenticated', o, format('%s,status) VALUES (%L,%L,true,''retail'',''cash'',''waitlisted'')', s, ca, o));
  v := v || E'\nX7 owner INSERT claim status=bidding: ' || pg_temp.probe_as('authenticated', o, format('%s,status) VALUES (%L,%L,true,''retail'',''cash'',''bidding'')', s, ca, o));
  v := v || E'\nX8 owner INSERT claim status=awarded + selected_contractor_id=k1 + selected_bid_amount: ' || pg_temp.probe_as('authenticated', o, format('%s,status,selected_contractor_id,selected_bid_amount) VALUES (%L,%L,true,''retail'',''cash'',''awarded'',%L,13560)', s, ca, o, k1));
  v := v || E'\nX9 owner INSERT claim status=completed (not a value claims_status_check allows): ' || pg_temp.probe_as('authenticated', o, format('%s,status) VALUES (%L,%L,true,''retail'',''cash'',''completed'')', s, ca, o));
  v := v || E'\nX10 owner INSERT claim status=NULL (explicit): ' || pg_temp.probe_as('authenticated', o, format('%s,status) VALUES (%L,%L,true,''retail'',''cash'',NULL)', s, ca, o));
  v := v || E'\nX11 owner INSERT claim, initial status, selected_contractor_id=k1: ' || pg_temp.probe_as('authenticated', o, format('%s,selected_contractor_id) VALUES (%L,%L,true,''retail'',''cash'',%L)', s, ca, o, k1));
  v := v || E'\nX12 owner INSERT claim, initial status, selected_bid_amount=13560: ' || pg_temp.probe_as('authenticated', o, format('%s,selected_bid_amount) VALUES (%L,%L,true,''retail'',''cash'',13560)', s, ca, o));
  v := v || E'\nX13 owner INSERT claim, initial status, completion_date=now(): ' || pg_temp.probe_as('authenticated', o, format('%s,completion_date) VALUES (%L,%L,true,''retail'',''cash'',now())', s, ca, o));
  v := v || E'\nX14 owner INSERT claim, initial status, contract_signed_at=now(): ' || pg_temp.probe_as('authenticated', o, format('%s,contract_signed_at) VALUES (%L,%L,true,''retail'',''cash'',now())', s, ca, o));
  v := v || E'\nX15 anon INSERT claim: ' || pg_temp.probe_as('anon', NULL, format('%s) VALUES (%L,%L,true,''retail'',''cash'')', s, ca, o));
  v := v || E'\nX16 stranger INSERT claim in owner o''s name: ' || pg_temp.probe_as('authenticated', stranger, format('%s) VALUES (%L,%L,true,''retail'',''cash'')', s, ca, o));

  -- Y: what a client may UPDATE claims.status to. Fixture (superuser): claim ca of o, documents_needed.
  BEGIN
    INSERT INTO public.claims (id, user_id, is_test, job_type, funding_type) VALUES (ca, o, true, 'retail', 'cash');
    v := v || E'\nY1 owner UPDATE status documents_needed -> active (+ ready_for_bids, roofing_bid_released_at: submit for bids): ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET status=''active'', ready_for_bids=true, roofing_bid_released_at=now() WHERE id=%L', ca));
    v := v || E'\nY2 owner UPDATE status -> contract_signed: ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET status=''contract_signed'' WHERE id=%L', ca));
    v := v || E'\nY3 owner UPDATE status -> waitlisted (state gate): ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET status=''waitlisted'' WHERE id=%L', ca));
    v := v || E'\nY4 owner UPDATE status -> submitted (repair intake): ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET status=''submitted'' WHERE id=%L', ca));
    v := v || E'\nY5 owner UPDATE status -> bidding: ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET status=''bidding'' WHERE id=%L', ca));
    v := v || E'\nY6 owner UPDATE status -> draft: ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET status=''draft'' WHERE id=%L', ca));
    v := v || E'\nY7 owner UPDATE status -> NULL: ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET status=NULL WHERE id=%L', ca));
    v := v || E'\nY8 owner UPDATE status -> contract_signed + contract_signed_at in one statement with other columns: ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET homeowner_notes=''x'', status=''contract_signed'', contract_signed_at=now(), updated_at=now() WHERE id=%L', ca));
    v := v || E'\nY-awarded owner UPDATE selected_contractor_id, selected_bid_amount, status=awarded (the React award''s claims write; see header): ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET selected_contractor_id=%L, selected_bid_amount=13560, status=''awarded'' WHERE id=%L', k1, ca));
    v := v || E'\nY9 owner UPDATE other columns, status re-sent unchanged (documents_needed): ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET homeowner_notes=''x'', status=''documents_needed'' WHERE id=%L', ca));
    v := v || E'\nY10 owner UPDATE trade-selector payload on an existing claim (no status): ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET funding_type=''cash'', policy_type=NULL, trades=ARRAY[''roofing''], job_type=''retail'', property_address=''1 Proof St, Zionsville, IN 46077'', property_state=''IN'', updated_at=now(), referral_code=''GH2479P'' WHERE id=%L', ca));
    v := v || E'\nY11 owner UPDATE o''s signed claim csig status contract_signed -> bidding: ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET status=''bidding'' WHERE id=%L', csig));
    v := v || E'\nY12 owner UPDATE o''s signed claim csig other column, status re-sent unchanged (contract_signed): ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET homeowner_notes=''x'', status=''contract_signed'' WHERE id=%L', csig));
    v := v || E'\nY13 owner UPDATE o''s bidding claim cbid other column only (status bidding untouched): ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET homeowner_notes=''x'' WHERE id=%L', cbid));
    v := v || E'\nY14 stranger UPDATE claim ca status=active: ' || pg_temp.probe_as('authenticated', stranger, format('UPDATE public.claims SET status=''active'' WHERE id=%L', ca));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- Q: what a client may INSERT into quotes. Fixture (superuser): claim ca of o, open for bids.
  -- Contractor k1 unless stated. Each line is undone on its own.
  BEGIN
    INSERT INTO public.claims (id, user_id, is_test, status, ready_for_bids, job_type, funding_type) VALUES (ca, o, true, 'active', true, 'retail', 'cash');
    v := v || E'\nQ0 contractor INSERT bid, status omitted (what both bid forms send; is_auto_bid=false): ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,is_auto_bid) VALUES (%L,%s,false)', bid_cols, qa, bid_vals));
    v := v || E'\nQ1 contractor INSERT bid status=submitted: ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,status) VALUES (%L,%s,''submitted'')', bid_cols, qa, bid_vals));
    v := v || E'\nQ2 contractor INSERT bid status=selected: ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,status) VALUES (%L,%s,''selected'')', bid_cols, qa, bid_vals));
    v := v || E'\nQ3 contractor INSERT bid status=declined: ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,status) VALUES (%L,%s,''declined'')', bid_cols, qa, bid_vals));
    v := v || E'\nQ4 contractor INSERT bid status=draft: ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,status) VALUES (%L,%s,''draft'')', bid_cols, qa, bid_vals));
    v := v || E'\nQ5 contractor INSERT bid status=expired: ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,status) VALUES (%L,%s,''expired'')', bid_cols, qa, bid_vals));
    v := v || E'\nQ6 contractor INSERT bid status=NULL (explicit): ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,status) VALUES (%L,%s,NULL)', bid_cols, qa, bid_vals));
    v := v || E'\nQ7 contractor INSERT bid bid_status=expired: ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,bid_status) VALUES (%L,%s,''expired'')', bid_cols, qa, bid_vals));
    v := v || E'\nQ8 contractor INSERT bid bid_status=superseded: ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,bid_status) VALUES (%L,%s,''superseded'')', bid_cols, qa, bid_vals));
    v := v || E'\nQ9 contractor INSERT bid is_auto_bid=true (status omitted; skips the D-199 gate): ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,is_auto_bid) VALUES (%L,%s,true)', bid_cols, qa, bid_vals));
    v := v || E'\nQ10 contractor INSERT bid renewed_from_quote_id=q1 (skips the bid-window check): ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,renewed_from_quote_id) VALUES (%L,%s,%L)', bid_cols, qa, bid_vals, q1));
    v := v || E'\nQ11 contractor INSERT bid homeowner_signed_at=now(): ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,homeowner_signed_at) VALUES (%L,%s,now())', bid_cols, qa, bid_vals));
    v := v || E'\nQ12 contractor INSERT bid contractor_signed_at=now(): ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,contractor_signed_at) VALUES (%L,%s,now())', bid_cols, qa, bid_vals));
    v := v || E'\nQ13 contractor INSERT bid payment_status=succeeded: ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,payment_status) VALUES (%L,%s,''succeeded'')', bid_cols, qa, bid_vals));
    v := v || E'\nQ14 contractor k1 INSERT a bid naming contractor k2: ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s) VALUES (%L,%L,%L,13560,5,678,true,''roofing'')', bid_cols, qa, ca, k2));
    v := v || E'\nQ15 homeowner o INSERT a bid on own claim naming contractor k1: ' || pg_temp.probe_as('authenticated', o, format('INSERT INTO public.quotes (id,%s) VALUES (%L,%s)', bid_cols, qa, bid_vals));
    v := v || E'\nQ16 anon INSERT a bid: ' || pg_temp.probe_as('anon', NULL, format('INSERT INTO public.quotes (id,%s) VALUES (%L,%s)', bid_cols, qa, bid_vals));
    v := v || E'\nQ17 contractor upsert of own existing quote q1 with status=selected in the INSERT tuple (ON CONFLICT (id) DO UPDATE SET notes; no client does this): ' || pg_temp.probe_as('authenticated', k1u, format('INSERT INTO public.quotes (id,claim_id,contractor_id,total_price,fee_percentage,fee_amount,is_test,trade_type,status) VALUES (%L,%L,%L,13560,5,678,true,''roofing'',''selected'') ON CONFLICT (id) DO UPDATE SET notes=''x''', q1, c1, k1));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- L: the legitimate flow, in the payload shapes the client pages send (column lists copied from
  -- trade-selector.html ~L1413-1479, react-app/app/trade-selector/page.tsx ~L943-1028,
  -- contractor-bid-form.html ~L5440-5462 / utils.ts buildQuoteInsert, and the change-bid payload).
  funnel_static := 'INSERT INTO public.claims (id,user_id,funding_type,policy_type,trades,job_type,property_address,property_state,updated_at,%sis_test,created_at) VALUES (%L,%L,''cash'',NULL,ARRAY[''roofing''],''retail'',''1 Proof St, Zionsville, IN 46077'',''IN'',now(),%strue,now() - interval ''3 days'')';
  funnel_react  := 'INSERT INTO public.claims (id,user_id,funding_type,policy_type,trades,job_type,property_address,property_city,property_state,property_zip,updated_at,%sis_test,created_at) VALUES (%L,%L,''cash'',NULL,ARRAY[''roofing''],''retail'',''1 Proof St, Zionsville, IN 46077'',''Zionsville'',''IN'',''46077'',now(),%strue,now())';
  client_bid    := 'INSERT INTO public.quotes (id,claim_id,contractor_id,total_price,fee_percentage,fee_amount,scope_summary,notes,decking_price_per_sheet,full_redeck_price,supplement_acknowledged,trade_type,value_adds,per_trade_breakdown,is_auto_bid,auto_renew,warranty_option_id,warranty_snapshot,workmanship_warranty_years,platform_fee_pct,platform_fee_basis,fee_accepted_at,is_test) VALUES (%L,%L,%L,%s,5,%s,''gh2479 proof'',NULL,NULL,NULL,true,''roofing'',''{}''::jsonb,NULL,false,true,NULL,NULL,NULL,5,''bid_amount'',now(),true)';
  BEGIN
    v := v || E'\nL1 homeowner creates a claim from the static funnel, NO referral code: ' || pg_temp.try_as('authenticated', o, format(funnel_static, '', cb, o, ''));
    v := v || format(' -> status=%s created_at_is_server_time=%s', (SELECT status FROM claims WHERE id = cb), (SELECT created_at = now() FROM claims WHERE id = cb));
    v := v || E'\nL2 homeowner creates a claim from the React funnel WITH a referral (referral_id, referral_code): ' || pg_temp.try_as('authenticated', o, format(funnel_react, 'referral_id,referral_code,', ca, o, quote_literal(rx) || ',''GH2479P'','));
    v := v || format(' -> status=%s referral_id set=%s | %s', (SELECT status FROM claims WHERE id = ca), (SELECT referral_id = rx FROM claims WHERE id = ca), pg_temp.acc(rx));
    v := v || E'\nL3 homeowner saves the trade selector again on that claim (UPDATE payload, no status, no referral_id): ' || pg_temp.try_as('authenticated', o, format('UPDATE public.claims SET funding_type=''cash'', policy_type=NULL, trades=ARRAY[''roofing''], job_type=''retail'', property_address=''1 Proof St, Zionsville, IN 46077'', property_state=''IN'', updated_at=now(), referral_code=''GH2479P'' WHERE id=%L', ca));
    v := v || E'\nL4 homeowner submits for bids (status=active, ready_for_bids, roofing_bid_released_at): ' || pg_temp.try_as('authenticated', o, format('UPDATE public.claims SET status=''active'', ready_for_bids=true, roofing_bid_released_at=now() WHERE id=%L', ca));
    v := v || E'\nL5 contractor k1 submits a bid (client INSERT payload, 15000): ' || pg_temp.try_as('authenticated', k1u, format(client_bid, qa, ca, k1, '15000', '750'));
    v := v || format(' -> status=%s bid_status=%s', (SELECT status FROM quotes WHERE id = qa), (SELECT bid_status FROM quotes WHERE id = qa));
    v := v || E'\nL6 contractor k1 revises the bid (change-bid UPDATE payload, 15500): ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET total_price=15500, fee_percentage=5, fee_amount=775, platform_fee_pct=5, platform_fee_basis=''bid_amount'', fee_accepted_at=now(), scope_summary=''gh2479 proof 2'', notes=NULL, supplement_acknowledged=true, trade_type=''roofing'', auto_renew=true, updated_at=now() WHERE id=%L', qa));
    v := v || format(' -> total_price=%s', (SELECT total_price FROM quotes WHERE id = qa));
    v := v || E'\nL7 contractor k2 submits a second bid (client INSERT payload, 16000): ' || pg_temp.try_as('authenticated', k2u, format(client_bid, qb, ca, k2, '16000', '800'));
    v := v || E'\nL8 contractor k2 withdraws: the rescind-bid Edge Function''s write, service_role bid_status=rescinded (existing defect, 23514, not this guard): ' || pg_temp.probe_as('service_role', NULL, format('UPDATE public.quotes SET bid_status=''rescinded'' WHERE id=%L', qb));
    v := v || E'\nL8b the same withdrawal with a value the constraint allows, service_role bid_status=cancelled: ' || pg_temp.probe_as('service_role', NULL, format('UPDATE public.quotes SET bid_status=''cancelled'', cancelled_at=now() WHERE id=%L', qb));
    v := v || E'\nL9 homeowner declines k2''s bid (status=declined): ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.quotes SET status=''declined'' WHERE id=%L', qb));
    v := v || E'\nL10 homeowner accepts k1''s bid, accept_bid(): ' || pg_temp.q_as('authenticated', o, format('SELECT ''amount='' || out_amount || '' declined='' || out_declined_count FROM public.accept_bid(%L,%L)', ca, qa));
    v := v || format(' -> k1 bid=%s k2 bid=%s claim=%s selected_contractor=k1:%s', (SELECT status FROM quotes WHERE id = qa), (SELECT status FROM quotes WHERE id = qb), (SELECT status FROM claims WHERE id = ca), (SELECT selected_contractor_id = k1 FROM claims WHERE id = ca));
    v := v || E'\nL11 homeowner stamps homeowner_signed_at on the selected bid (contract-signing): ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET homeowner_signed_at=now() WHERE id=%L', qa));
    v := v || E'\nL12 contractor k1 stamps contractor_signed_at on the selected bid: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET contractor_signed_at=now() WHERE id=%L', qa));
    v := v || E'\nL13 docusign-webhook''s write, service_role claims status=contract_signed + contract_signed_at: ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.claims SET status=''contract_signed'', contract_signed_at=now() WHERE id=%L', ca));
    v := v || E'\nL14 homeowner tries the completion himself: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.claims SET completion_date=now() WHERE id=%L', ca));
    v := v || E'\nL15 ' || pg_temp.mjc(ca, k1);
    v := v || E'\nL RESULT ' || format('claim status=%s | ', (SELECT status FROM claims WHERE id = ca)) || pg_temp.acc(rx);
    v := v || E'\nL16 homeowner on the other claim: state gate, status=waitlisted: ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET status=''waitlisted'' WHERE id=%L', cb));
    v := v || E'\nL17 homeowner on the other claim: repair intake, repair columns then status=submitted: ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET job_type=''repair'', trades=ARRAY[''roofing''], homeowner_notes=''leak'' WHERE id=%L AND user_id=%L', cb, o))
           || ' / ' || pg_temp.probe_as('authenticated', o, format('UPDATE public.claims SET status=''submitted'' WHERE id=%L AND user_id=%L', cb, o));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- R: the React award (bids/actions.ts awardClaimToContractor), three direct writes by the homeowner.
  -- Fixture (superuser): claim ca of o open for bids with two submitted bids.
  BEGIN
    INSERT INTO public.claims (id, user_id, is_test, status, ready_for_bids, job_type, funding_type) VALUES (ca, o, true, 'active', true, 'retail', 'cash');
    INSERT INTO public.quotes (id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, is_test, trade_type, is_auto_bid) VALUES (qa, ca, k1, 15000, 5, 750, true, 'roofing', true), (qb, ca, k2, 16000, 5, 800, true, 'roofing', true);
    v := v || E'\nR1 homeowner award step 1, claims selected_contractor_id + selected_bid_amount + status=awarded (existing gh-1532 defect, see header): ' || pg_temp.try_as('authenticated', o, format('UPDATE public.claims SET selected_contractor_id=%L, selected_bid_amount=15000, status=''awarded'' WHERE id=%L', k1, ca));
    v := v || E'\nR2 homeowner award step 2, winning quote status=selected: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', qa));
    v := v || E'\nR3 homeowner award step 3, the other quotes status=declined: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''declined'' WHERE claim_id=%L AND id<>%L', ca, qa));
    v := v || E'\nR RESULT ' || format('k1 bid=%s k2 bid=%s claim=%s', (SELECT status FROM quotes WHERE id = qa), (SELECT status FROM quotes WHERE id = qb), (SELECT status FROM claims WHERE id = ca));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- S: service_role (every Edge Function), an admin, and nothing else changes for them.
  BEGIN
    v := v || E'\nS1 service_role INSERT claim born contract_signed with selected contractor, amount, contract_signed_at: ' || pg_temp.try_as('service_role', NULL, format('INSERT INTO public.claims (id,user_id,is_test,status,selected_contractor_id,selected_bid_amount,contract_signed_at,job_type,funding_type) VALUES (%L,%L,true,''contract_signed'',%L,15000,now(),''retail'',''cash'')', ca, o, k1));
    v := v || E'\nS2 service_role INSERT quote born selected with signing and payment state: ' || pg_temp.probe_as('service_role', NULL, format('INSERT INTO public.quotes (id,%s,status,homeowner_signed_at,contractor_signed_at,payment_status) VALUES (%L,%s,''selected'',now(),now(),''succeeded'')', bid_cols, qa, bid_vals));
    v := v || E'\nS3 service_role INSERT auto-bid (process-auto-bids payload: status submitted, is_auto_bid true, bid_status active): ' || pg_temp.probe_as('service_role', NULL, format('INSERT INTO public.quotes (id,claim_id,contractor_id,total_price,fee_percentage,platform_fee_pct,fee_amount,fee_agreed,fee_agreed_at,status,trade_type,is_auto_bid,auto_renew,scope_summary,bid_status,expires_at,is_test) VALUES (%L,%L,%L,15000,5,5,750,true,now(),''submitted'',''roofing'',true,false,''auto'',''active'',now()+interval ''14 days'',true)', qa, ca, k1));
    v := v || E'\nS4 service_role INSERT renewal quote (process-bid-expirations payload as written: renewed_from_quote_id, bid_status active, no fee columns; existing defect 23502, not this guard): ' || pg_temp.probe_as('service_role', NULL, format('INSERT INTO public.quotes (id,claim_id,contractor_id,total_price,auto_renew,renewed_from_quote_id,expires_at,bid_status,trade_type,is_test) VALUES (%L,%L,%L,13560,true,%L,now()+interval ''14 days'',''active'',''roofing'',true)', qa, c1, k1, q1));
    v := v || E'\nS4b the same renewal INSERT with the two NOT NULL fee columns filled in: ' || pg_temp.probe_as('service_role', NULL, format('INSERT INTO public.quotes (id,claim_id,contractor_id,total_price,fee_percentage,fee_amount,auto_renew,renewed_from_quote_id,expires_at,bid_status,trade_type,is_test) VALUES (%L,%L,%L,13560,5,678,true,%L,now()+interval ''14 days'',''active'',''roofing'',true)', qa, c1, k1, q1));
    v := v || E'\nS5 service_role UPDATE claims status -> bidding + selected_contractor_id NULL (switch-contractor, process-dunning): ' || pg_temp.probe_as('service_role', NULL, format('UPDATE public.claims SET status=''bidding'', selected_contractor_id=NULL, selected_bid_amount=NULL WHERE id=%L', ca));
    v := v || E'\nS6 service_role UPDATE o''s bidding claim cbid status -> contract_signed (docusign-webhook, process-dunning restore): ' || pg_temp.probe_as('service_role', NULL, format('UPDATE public.claims SET status=''contract_signed'' WHERE id=%L', cbid));
    v := v || E'\nS7 service_role UPDATE claims status -> draft: ' || pg_temp.probe_as('service_role', NULL, format('UPDATE public.claims SET status=''draft'' WHERE id=%L', cbid));
    v := v || E'\nS8 admin (authenticated, admin email) UPDATE o''s bidding claim cbid status -> contract_signed: ' || pg_temp.probe_as('authenticated', stranger, format('UPDATE public.claims SET status=''contract_signed'' WHERE id=%L', cbid), admin_email);
    v := v || E'\nS8-CONTROL the same statement by the same login without the admin email: ' || pg_temp.probe_as('authenticated', stranger, format('UPDATE public.claims SET status=''contract_signed'' WHERE id=%L', cbid));
    v := v || E'\nS9 service_role completion of o''s signed claim csig (mark-job-complete''s write): ' || pg_temp.probe_as('service_role', NULL, format('UPDATE public.claims SET completion_date=now() WHERE id=%L', csig));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  RETURN v;
END $s$;

DO $run$
BEGIN
  RAISE EXCEPTION E'GH2479_BORN_FORCED_ROLLBACK %', pg_temp.gh2479_born_scenario();
END $run$;
