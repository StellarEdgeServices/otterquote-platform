-- gh-2479 / gh-2403 proof: the completion path end to end, with an accruable referral so the guards are the ONLY barrier.
-- Answers the two CLOSE-REVIEW: FAIL comments of 2026-10-14T12:45Z (#2479 6168644280, #2403 6168643728) on the repository side:
-- one self-contained, rolled-back file that a non-author can run in one sitting and that prints, side by side,
--   * 409: mark-job-complete on an ALREADY-AWARDED claim is refused and nothing accrues (E3q, A1), with a CONTROL line that runs the
--     pre-#2615 rule (awarded accepted) and does accrue, so the 409 is shown to be the only barrier;
--   * accrual: a contract_signed claim still completes and accrues 200.00 with one payout_approvals row (C1);
--   * the refuter's own cases V1-V3 (quote claim_id re-pointing), E1, E7 (born-selected quote), E3 (one user as owner and contractor).
-- WHY THIS FILE EXISTS (not only gh2479_quotes_guard_proof.sql / gh2479_born_state_guard_proof.sql): in those files the referral rx
-- is left in status 'clicked', so apply_referral_commission() check (b) already blocks every accrual and a "commission=null" line
-- does not show that the quote guard or the born-state guard held. Here rx is armed (claim_submitted, inside the window, is_test,
-- no commission yet, claim carries a selected quote >= 10000) before every case, so a null line means a guard did its job.
-- mark-job-complete is not reachable from SQL: pg_temp.mjc() applies its two decisions at main (supabase/functions/mark-job-complete/
-- index.ts: the caller's contractor has exactly one selected/awarded quote on the claim; COMPLETABLE_STATES = ["contract_signed"]
-- since PR #2615, else 409) and then makes its one write, completion_date, as service_role. The HTTP and signed-in PostgREST legs
-- are in supabase/tests/gh2479_signed_in_leg.sh. This file is the SQL layer.
--
-- PRODUCTION FIDELITY (review 6170832811): the local harness lacks quotes_enforce_bid_can_submit, trg_enforce_bid_window_expiry and
-- claims_payment_method_guard. On production they can refuse C1's superuser INSERT of quote qc (printed as "C1 FIXTURE INSERT ... REFUSED",
-- C1 is then not proven; the born-state proof sets the template and payment-method fixtures in-transaction, copy them if it happens),
-- can refuse E1a/E7a before the gh-2479 born-state guard (every REJECTED line now prints "[by <function>]": read it, the gh-2479 guards
-- are claims_guard_referral_columns and quotes_guard_homeowner_columns), and can refuse E3q-c (the CONTROL line then does not accrue).
-- The PROD-ONLY GATES line prints their state first. The file aborts with no write if any fixture is not is_test.
-- Run (production yeszghaspzwwstvsrioa, is_test fixtures only; the last statement is a deliberate RAISE EXCEPTION, so everything
-- rolls back and the raw findings are the exception text; send it as ONE statement batch, no COMMIT anywhere):
--   AFTER the fix (now): run this file alone.
--   BEFORE the fix: not runnable on production any more; the local PG16 negative control is supabase/tests/local_pg16/run.sh (mode pre).
-- Fixtures (same ids as the other gh2479 proofs): homeowner o, claims c1 (awarded, quote q1 selected 13560, contractor k1),
-- csig (contract_signed), contractor k1 with login k1u, referral rx (is_test, on an is_test agent).
-- Expected AFTER (the guards live): A1 409 and commission=null rows=0; C1 COMPLETES and commission=200 rows=1; V2 REJECTED 42501,
--   V3 commission=null rows=0; E1a, E7a REJECTED 42501 and E1/E7 RESULT commission=null rows=0; E3a REJECTED 42501;
--   E3q-c ACCEPTED (the owner may award), E3q-e REFUSES 409 and E3q RESULT commission=null rows=0;
--   E3q CONTROL (pre-#2615 rule, NOT a product path) COMPLETES with commission=200 rows=1.
-- Expected BEFORE the guards (local mode pre; payout rows then carry is_test=false, the pre-fix function omitted it): V2 ACCEPTED and
--   V3 commission=200; E1a, E7a, E3a, E3c ACCEPTED and E1, E7, E3 RESULT commission=200; A1, C1, E3q lines as AFTER (they do not depend on
--   the guards: the 409 and the accrual on contract_signed are mark-job-complete's and the trigger's).
-- Local run: bash supabase/tests/local_pg16/run.sh supabase/tests/gh2479_completion_path_proof.sql [post|pre].

CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_sql text, p_email text DEFAULT 'gh2479-completion-proof@example.invalid') RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int; ctx text; refuser text;
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
    GET STACKED DIAGNOSTICS ctx = PG_EXCEPTION_CONTEXT;
    refuser := COALESCE(substring(ctx FROM 'function ([A-Za-z0-9_.]+)\('), '(no function: constraint, RLS or privilege)');
    EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
    -- the refusing trigger function is printed so a reader can tell the gh-2479 guard from another guard (D-199 bid gate,
    -- bid-window, payment-method) that fires first on production
    RETURN 'REJECTED ' || SQLSTATE || ' [by ' || refuser || '] ' || left(SQLERRM, 110);
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

-- mark-job-complete, as the Edge Function decides it at main. p_completable defaults to main's COMPLETABLE_STATES.
CREATE FUNCTION pg_temp.mjc(p_claim uuid, p_contractor uuid, p_completable text[] DEFAULT ARRAY['contract_signed']) RETURNS text
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
  IF c.status IS NULL OR NOT (c.status = ANY (p_completable)) THEN
    RETURN format('mark-job-complete: REFUSES 409 (claim status %s)', COALESCE(c.status, 'NULL'));
  END IF;
  RETURN 'mark-job-complete: COMPLETES, ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.claims SET completion_date=now() WHERE id=%L', p_claim));
END $f$;

CREATE FUNCTION pg_temp.gh2479_completion_scenario() RETURNS text
LANGUAGE plpgsql AS $s$
DECLARE
  o    constant uuid := 'f6c14b57-59dc-43ce-b510-04277a71f5af'; -- is_test homeowner
  c1   constant uuid := '4d764e19-0549-43db-a967-9ab564f05f23'; -- o's claim, awarded
  q1   constant uuid := 'ff1f8323-1e74-43d6-a6b4-116b940dfa65'; -- selected 13560 on c1, contractor k1
  csig constant uuid := '6aea8081-a3a3-4a22-a1a8-1becb7fedcb6'; -- o's claim, contract_signed
  k1   constant uuid := '986ce2b6-39fd-4a2c-aba4-a806c618c8c0'; k1u constant uuid := 'd4def812-aebc-444c-bdee-f68bccc19b61';
  rx   constant uuid := '770c7bd8-532b-4f75-8a82-dfca275fcd98'; -- is_test referral on an is_test agent
  ca   constant uuid := '00000000-2479-4c00-8000-00000000000a'; -- new rows, fixed ids so the output is identical run to run
  c3   constant uuid := '00000000-2479-4c00-8000-00000000000c';
  qa   constant uuid := '00000000-2479-4c00-8000-0000000000a1';
  qc   constant uuid := '00000000-2479-4c00-8000-0000000000a3';
  bid_cols constant text := 'claim_id,contractor_id,total_price,fee_percentage,fee_amount,is_test,trade_type';
  bid_vals text := format('%L,%L,13560,5,678,true,''roofing''', ca, k1);
  v text := ''; bc text; ctx text;
BEGIN
  v := v || E'\nFIXTURES ' || format('owner_is_test=%s claims(c1,csig)_is_test=%s c1=%s csig=%s q1_is_test=%s q1=%s/%s k1_is_test=%s k1u_is_test=%s rx_is_test=%s rx_agent_is_test=%s new ids free=%s',
    (SELECT is_test FROM profiles WHERE id = o), (SELECT bool_and(is_test) FROM claims WHERE id IN (c1, csig)),
    (SELECT status FROM claims WHERE id = c1), (SELECT status FROM claims WHERE id = csig),
    (SELECT is_test FROM quotes WHERE id = q1), (SELECT status FROM quotes WHERE id = q1), (SELECT total_price FROM quotes WHERE id = q1),
    (SELECT is_test FROM contractors WHERE id = k1), (SELECT is_test FROM profiles WHERE id = k1u),
    (SELECT is_test FROM referrals WHERE id = rx), (SELECT a.is_test FROM referral_agents a JOIN referrals r ON r.referral_agent_id = a.id WHERE r.id = rx),
    (SELECT count(*) = 0 FROM claims WHERE id IN (ca, c3)) AND (SELECT count(*) = 0 FROM quotes WHERE id IN (qa, qc)));
  -- FAIL CLOSED: every fixture must read is_test = true (a missing row reads NULL) before the first write.
  IF NOT COALESCE((SELECT is_test FROM profiles WHERE id = o), false)
     OR NOT COALESCE((SELECT bool_and(is_test) AND count(*) = 2 FROM claims WHERE id IN (c1, csig)), false)
     OR NOT COALESCE((SELECT is_test FROM quotes WHERE id = q1), false)
     OR NOT COALESCE((SELECT is_test FROM contractors WHERE id = k1), false)
     OR NOT COALESCE((SELECT is_test FROM profiles WHERE id = k1u), false)
     OR NOT COALESCE((SELECT is_test FROM referrals WHERE id = rx), false)
     OR NOT COALESCE((SELECT a.is_test FROM referral_agents a JOIN referrals r ON r.referral_agent_id = a.id WHERE r.id = rx), false)
     OR EXISTS (SELECT 1 FROM claims WHERE id IN (ca, c3)) OR EXISTS (SELECT 1 FROM quotes WHERE id IN (qa, qc)) THEN
    RAISE EXCEPTION 'GH2479_COMPLETION_FIXTURE_ABORT: a fixture is missing, not is_test, or a new id is taken; nothing was written%', v;
  END IF;
  IF to_regprocedure('public.bid_can_submit(uuid,text,text)') IS NOT NULL THEN
    EXECUTE format('SELECT public.bid_can_submit(%L, ''roofing'', ''retail'') ->> ''can_submit''', k1) INTO bc;
  END IF;
  -- production-only guards that can refuse the superuser fixture INSERT of quote qc, or a case line, before the gh-2479 guard does
  -- (absent locally): their state is printed here, and try_as() prints the function that refused each case.
  v := v || E'\nPROD-ONLY GATES ' || COALESCE((SELECT string_agg(tgname::text || ' [' || tgenabled::text || ']', ' ; ' ORDER BY tgname)
    FROM pg_trigger WHERE tgname IN ('quotes_enforce_bid_can_submit', 'trg_enforce_bid_window_expiry', 'claims_payment_method_guard') AND NOT tgisinternal), '(none present)')
    || ' | bid_can_submit(k1)=' || COALESCE(bc, 'n/a locally')
    || ' | k1.has_payment_method=' || COALESCE((SELECT to_jsonb(k) ->> 'has_payment_method' FROM public.contractors k WHERE k.id = k1), 'n/a');
  v := v || E'\nGUARDS ' || COALESCE((SELECT string_agg(tgname::text || ' [' || tgenabled::text || ']', ' ; ' ORDER BY tgname)
    FROM pg_trigger WHERE tgname IN ('claims_guard_referral_columns', 'quotes_guard_homeowner_columns', 'after_claim_completed') AND NOT tgisinternal), '(none)');

  -- A1: mark-job-complete on an ALREADY-AWARDED claim (c1: awarded, selected quote q1 of k1) carrying an accruable referral.
  BEGIN
    UPDATE public.claims SET referral_id = rx, completion_date = NULL WHERE id = c1;
    UPDATE public.referrals SET status = 'claim_submitted', created_at = (SELECT created_at FROM public.claims WHERE id = c1) - interval '5 days',
           commission_amount = NULL, recruit_commission_amount = NULL, job_value = NULL, is_test = true WHERE id = rx;
    DELETE FROM public.payout_approvals WHERE referral_id = rx;
    v := v || E'\nA1 claim c1 status=' || (SELECT status FROM claims WHERE id = c1) || ', rx armed: ' || pg_temp.acc(rx);
    v := v || E'\nA1 ' || pg_temp.mjc(c1, k1);
    v := v || E'\nA1 RESULT ' || pg_temp.acc(rx);
    v := v || E'\nA1 CONTROL (the pre-#2615 rule, awarded accepted; NOT a product path) ' || pg_temp.mjc(c1, k1, ARRAY['contract_signed', 'awarded']);
    v := v || E'\nA1 CONTROL RESULT ' || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- C1: a contract_signed claim still completes and accrues (the legitimate path). Fixture (superuser): a selected quote of k1 on csig.
  BEGIN
    BEGIN
      INSERT INTO public.quotes (id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, status, is_test, trade_type)
        VALUES (qc, csig, k1, 13560, 5, 678, 'selected', true, 'roofing');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS ctx = PG_EXCEPTION_CONTEXT;
      -- on production the D-199 bid gate / bid-window guard can refuse this superuser fixture; C1 is then NOT proven. Say so and move on.
      v := v || E'\nC1 FIXTURE INSERT of quote qc REFUSED ' || SQLSTATE || ' [by ' || COALESCE(substring(ctx FROM 'function ([A-Za-z0-9_.]+)\('), '?') || '] ' || left(SQLERRM, 110)
        || ' -> C1 below is NOT a valid accrual proof; run the born-state proof''s in-transaction fixtures (validated template, payment method) first';
    END;
    UPDATE public.claims SET referral_id = rx, completion_date = NULL WHERE id = csig;
    UPDATE public.referrals SET status = 'claim_submitted', created_at = (SELECT created_at FROM public.claims WHERE id = csig) - interval '5 days',
           commission_amount = NULL, recruit_commission_amount = NULL, job_value = NULL, is_test = true WHERE id = rx;
    DELETE FROM public.payout_approvals WHERE referral_id = rx;
    v := v || E'\nC1 claim csig status=' || (SELECT status FROM claims WHERE id = csig) || ', rx armed: ' || pg_temp.acc(rx);
    v := v || E'\nC1 ' || pg_temp.mjc(csig, k1);
    v := v || E'\nC1 RESULT ' || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- V1-V3: the refuter's attack (#2479 comment 5998207363), statement for statement, with rx armed.
  BEGIN
    UPDATE public.claims SET referral_id = NULL, completion_date = NULL WHERE id = c1;
    v := v || E'\nV1 OWNER INSERT new claim c3 with referral_id=rx (initial state): ' || pg_temp.try_as('authenticated', o, format('INSERT INTO public.claims (id,user_id,is_test,referral_id) VALUES (%L,%L,true,%L)', c3, o, rx));
    UPDATE public.claims SET status = 'contract_signed' WHERE id = c3;   -- fixture (superuser)
    UPDATE public.referrals SET status = 'claim_submitted', created_at = (SELECT created_at FROM public.claims WHERE id = c3) - interval '5 days',
           commission_amount = NULL, recruit_commission_amount = NULL, job_value = NULL, is_test = true WHERE id = rx;
    DELETE FROM public.payout_approvals WHERE referral_id = rx;
    v := v || E'\nV1 RESULT ' || pg_temp.acc(rx);
    v := v || E'\nV2 OWNER UPDATE quotes SET claim_id=c3 on the selected quote of c1: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET claim_id=%L WHERE id=%L', c3, q1));
    v := v || E'\nV2 STATE ' || format('quote.claim_id=c3:%s quote.claim_id=c1:%s quote.status=%s total_price=%s', (SELECT claim_id = c3 FROM quotes WHERE id = q1), (SELECT claim_id = c1 FROM quotes WHERE id = q1), (SELECT status FROM quotes WHERE id = q1), (SELECT total_price FROM quotes WHERE id = q1));
    v := v || E'\nV3 service_role (what mark-job-complete does for the contractor) UPDATE c3.completion_date: ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.claims SET completion_date=now() WHERE id=%L', c3));
    v := v || E'\nV3 RESULT ' || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- E1: a contractor (not the owner) INSERTs a quote born selected on another user's signed claim ca carrying rx.
  BEGIN
    INSERT INTO public.claims (id, user_id, is_test, status, referral_id, job_type, funding_type) VALUES (ca, o, true, 'contract_signed', rx, 'retail', 'cash');
    UPDATE public.referrals SET status = 'claim_submitted', created_at = (SELECT created_at FROM public.claims WHERE id = ca) - interval '5 days',
           commission_amount = NULL, recruit_commission_amount = NULL, job_value = NULL, is_test = true WHERE id = rx;
    DELETE FROM public.payout_approvals WHERE referral_id = rx;
    v := v || E'\nE1a CONTRACTOR k1 (not the owner) INSERT quote on claim ca born status=selected, 13560: ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,status) VALUES (%L,%s,''selected'')', bid_cols, qa, bid_vals));
    v := v || E'\nE1b ' || pg_temp.mjc(ca, k1);
    v := v || E'\nE1 RESULT ' || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- E7: the same with is_auto_bid = true (skips the D-199 bid gate).
  BEGIN
    INSERT INTO public.claims (id, user_id, is_test, status, referral_id, job_type, funding_type) VALUES (ca, o, true, 'contract_signed', rx, 'retail', 'cash');
    UPDATE public.referrals SET status = 'claim_submitted', created_at = (SELECT created_at FROM public.claims WHERE id = ca) - interval '5 days',
           commission_amount = NULL, recruit_commission_amount = NULL, job_value = NULL, is_test = true WHERE id = rx;
    DELETE FROM public.payout_approvals WHERE referral_id = rx;
    v := v || E'\nE7a CONTRACTOR k1 INSERT quote on claim ca born selected with is_auto_bid=true: ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.quotes (id,%s,status,is_auto_bid) VALUES (%L,%s,''selected'',true)', bid_cols, qa, bid_vals));
    v := v || E'\nE7b ' || pg_temp.mjc(ca, k1);
    v := v || E'\nE7 RESULT ' || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- E3: one user alone (k1's own login is both claim owner and contractor), statement for statement. Where the guards hold, the
  -- born-contract_signed claim never exists, so no claim carries rx; the line is the refuter's sequence, E3q below is the live route.
  BEGIN
    UPDATE public.referrals SET status = 'claim_submitted', created_at = now() - interval '5 days',
           commission_amount = NULL, recruit_commission_amount = NULL, job_value = NULL, is_test = true WHERE id = rx;
    DELETE FROM public.payout_approvals WHERE referral_id = rx;
    v := v || E'\nE3a CONTRACTOR-USER k1u INSERT own claim ca (referral rx, born contract_signed): ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.claims (id,user_id,is_test,status,referral_id,job_type,funding_type) VALUES (%L,%L,true,''contract_signed'',%L,''retail'',''cash'')', ca, k1u, rx));
    v := v || E'\nE3b k1u INSERT own quote on it, status submitted, 10000: ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.quotes (id,claim_id,contractor_id,total_price,fee_percentage,fee_amount,status,is_test,trade_type) VALUES (%L,%L,%L,10000,5,500,''submitted'',true,''roofing'')', qa, ca, k1));
    v := v || E'\nE3c k1u (as claim owner) UPDATE that quote status=selected: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', qa));
    v := v || E'\nE3d ' || pg_temp.mjc(ca, k1);
    v := v || E'\nE3 RESULT ' || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- E3q: the one route the guards leave open (the owner-contractor awards their own claim with the React award's direct writes),
  -- closed by the 409. rx is armed after the claim exists so check (b) and the window cannot be what blocks the accrual.
  BEGIN
    v := v || E'\nE3q-a k1u INSERT own claim ca in the initial state (referral rx): ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.claims (id,user_id,is_test,referral_id,job_type,funding_type) VALUES (%L,%L,true,%L,''retail'',''cash'')', ca, k1u, rx));
    UPDATE public.referrals SET status = 'claim_submitted', created_at = (SELECT created_at FROM public.claims WHERE id = ca) - interval '5 days',
           commission_amount = NULL, recruit_commission_amount = NULL, job_value = NULL, is_test = true WHERE id = rx;
    DELETE FROM public.payout_approvals WHERE referral_id = rx;
    v := v || E'\nE3q-b k1u INSERT own bid, 10000: ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.quotes (id,claim_id,contractor_id,total_price,fee_percentage,fee_amount,is_test,trade_type,is_auto_bid) VALUES (%L,%L,%L,10000,5,500,true,''roofing'',false)', qa, ca, k1));
    v := v || E'\nE3q-c k1u UPDATE own claim selected_contractor_id, selected_bid_amount, status=awarded: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.claims SET selected_contractor_id=%L, selected_bid_amount=10000, status=''awarded'' WHERE id=%L', k1, ca));
    v := v || E'\nE3q-d k1u UPDATE own bid status=selected: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', qa));
    v := v || E'\nE3q-e ' || pg_temp.mjc(ca, k1);
    v := v || E'\nE3q RESULT ' || format('claim status=%s | ', (SELECT status FROM claims WHERE id = ca)) || pg_temp.acc(rx);
    v := v || E'\nE3q CONTROL (the pre-#2615 rule, awarded accepted; NOT a product path) ' || pg_temp.mjc(ca, k1, ARRAY['contract_signed', 'awarded']);
    v := v || E'\nE3q CONTROL RESULT ' || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  RETURN v;
END $s$;

DO $proof$
BEGIN
  RAISE EXCEPTION E'GH2479_COMPLETION_FORCED_ROLLBACK%', pg_temp.gh2479_completion_scenario();
END
$proof$;
