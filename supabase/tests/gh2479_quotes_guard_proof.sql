-- gh-2479 / gh-2519 proof: quotes claim_id / total_price / status guard and referral_agents.agent_type guard
-- (migration 20261005170000_gh2479_quotes_homeowner_guard.sql).
-- Run against production (yeszghaspzwwstvsrioa) in ONE statement batch that is forced to roll back.
--   BEFORE the fix : run this file alone.
--   AFTER the fix  : run the migration body (with its own BEGIN; / COMMIT; lines removed, so nothing can
--                    commit) followed by this file, in the same single statement batch.
-- The last statement is a deliberate RAISE EXCEPTION, so the whole batch (migration DDL included) rolls
-- back; the raw findings are the exception text. Each group below also runs inside its own savepoint
-- (a block that raises P0U01 and catches it), so one group's writes never feed the next.
-- Everything touched is is_test (the FIXTURES line prints it): homeowner f6c14b57 and its claims, the
-- quotes ff1f8323 / 0a334300 / be305d7c / 6e3d1807, contractors 986ce2b6, bb07fc40 and 2bc792be, referral 770c7bd8,
-- agents 02fbf1c3 and 1927861f. The one is_test=false quote (403940dc) is never addressed.
--
-- Expected BEFORE (the bugs): V2 ACCEPTED and V3 RESULT commission=200.00; P1, P2, P3, P3b, P4 ACCEPTED;
--   K4, K5 ACCEPTED; A1 ACCEPTED.
-- Expected AFTER: V2 REJECTED 42501 and V3 RESULT commission=null, payout_approvals rows=0; P1, P2, P3,
--   P3b, P4 REJECTED 42501 with total_price / status / contractor unchanged; K4, K5 REJECTED 42501;
--   A1 REJECTED 42501.
-- Expected the SAME before and after (legitimate paths and controls):
--   P0 rows=0 (RLS); P5 REJECTED (the INSERT arm is checked first: D-199 bid gate / INSERT policy);
--   P6 REJECTED 42501 (anon holds no UPDATE on quotes);
--   K1, K2b, K3 ACCEPTED; K6 rows=0;
--   K2 REJECTED 23514: the client's renewal payload sends bid_status='submitted', which
--      quotes_bid_status_check does not allow. That is an existing defect, not this guard (K2b is the
--      same payload without bid_status and lands);
--   H1, H2b, H2c, H3 ACCEPTED; H4 accept_bid returns the quote and the claim is awarded;
--   H2a REJECTED P0001 contractor_no_payment_method even though contractor k3 has a payment method:
--      claims_enforce_payment_method_on_award() is SECURITY INVOKER and reads public.contractors, which a
--      homeowner cannot SELECT under RLS. That is an existing defect on the claims table, not this guard;
--   S1 ACCEPTED; S2 RESULT commission=200.00; A2, A3, A4 ACCEPTED.

CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_sql text, p_email text DEFAULT 'gh2479-proof@example.invalid') RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_role = 'anon' THEN json_build_object('role', 'anon')::text
    ELSE json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text END, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row changed)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 100);
  END;
END $f$;

CREATE FUNCTION pg_temp.q_as(p_role text, p_sub uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_role = 'anon' THEN json_build_object('role', 'anon')::text
    ELSE json_build_object('sub', p_sub, 'role', p_role, 'email', 'gh2479-proof@example.invalid')::text END, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql INTO v;
    EXECUTE 'RESET ROLE';
    RETURN COALESCE(v, 'NULL');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 100);
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

CREATE FUNCTION pg_temp.gh2479_quotes_scenario() RETURNS text
LANGUAGE plpgsql AS $s$
DECLARE
  o    constant uuid := 'f6c14b57-59dc-43ce-b510-04277a71f5af'; -- is_test homeowner
  stranger constant uuid := '6a9ec731-85d4-4076-ae99-bc77829ee393'; -- another is_test homeowner
  c1   constant uuid := '4d764e19-0549-43db-a967-9ab564f05f23'; -- o's claim, awarded
  q1   constant uuid := 'ff1f8323-1e74-43d6-a6b4-116b940dfa65'; -- selected 13560 on c1, contractor k1
  k1   constant uuid := '986ce2b6-39fd-4a2c-aba4-a806c618c8c0'; k1u constant uuid := 'd4def812-aebc-444c-bdee-f68bccc19b61';
  cs   constant uuid := '8dcf76f1-f518-4363-a37f-192dec10b9bb'; -- o's claim, bidding
  qs   constant uuid := '0a334300-2a4a-4ba6-ac77-efea0fa73179'; -- submitted 15000 on cs, contractor k2
  cb   constant uuid := '374a2053-de6c-4f9a-9974-2e22714a4795'; -- o's claim, bidding
  qb   constant uuid := 'be305d7c-7982-4e37-89a3-95b2ae79ce63'; -- submitted 15000 on cb, contractor k2
  k2   constant uuid := 'bb07fc40-3607-4f3f-ac44-dffd4ca95111'; k2u constant uuid := '189b85ad-0ab0-4e54-9083-c51c3ef42a1d';
  k3   constant uuid := '2bc792be-b677-4ac1-bc68-94b1561d9757'; -- is_test contractor with has_payment_method = true
  q2   constant uuid := '6e3d1807-b96c-4595-8153-ad7e39dc4aa7'; -- selected 15000 on o's contract_signed claim
  rx   constant uuid := '770c7bd8-532b-4f75-8a82-dfca275fcd98'; -- another agent's referral, clicked
  insp_agent constant uuid := '1927861f-8836-49ce-a528-08c432cc69cc'; insp_user constant uuid := '3ea4d929-b916-4cc9-a285-d052df397992';
  c3 uuid := gen_random_uuid(); c4 uuid := gen_random_uuid();
  v text := ''; t text; rnew uuid;
BEGIN
  v := v || E'\nFIXTURES ' || format('owner_is_test=%s stranger_is_test=%s claims(c1,cs,cb)_is_test=%s quotes(q1,qs,qb,q2)_is_test=%s contractors(k1,k2,k3)_is_test=%s k3_has_payment_method=%s rx_is_test=%s insp_agent_is_test=%s q1=%s/%s qs=%s/%s qb=%s/%s',
    (SELECT is_test FROM profiles WHERE id = o), (SELECT is_test FROM profiles WHERE id = stranger),
    (SELECT bool_and(is_test) FROM claims WHERE id IN (c1, cs, cb)), (SELECT bool_and(is_test) FROM quotes WHERE id IN (q1, qs, qb, q2)),
    (SELECT bool_and(is_test) FROM contractors WHERE id IN (k1, k2, k3)), (SELECT has_payment_method FROM contractors WHERE id = k3), (SELECT is_test FROM referrals WHERE id = rx),
    (SELECT is_test FROM referral_agents WHERE id = insp_agent),
    (SELECT status FROM quotes WHERE id = q1), (SELECT total_price FROM quotes WHERE id = q1),
    (SELECT status FROM quotes WHERE id = qs), (SELECT total_price FROM quotes WHERE id = qs),
    (SELECT status FROM quotes WHERE id = qb), (SELECT total_price FROM quotes WHERE id = qb));
  v := v || E'\nGUARDS ' || format('quotes_guard_homeowner_columns=%s referral_agents_guard_agent_type=%s',
    (SELECT count(*) FROM pg_trigger WHERE tgname = 'quotes_guard_homeowner_columns' AND NOT tgisinternal),
    (SELECT count(*) FROM pg_trigger WHERE tgname = 'referral_agents_guard_agent_type' AND NOT tgisinternal));

  -- V: the refuter's attack (#2479 comment 5998207363, V1-V3), statement for statement.
  BEGIN
    v := v || E'\nV1 OWNER INSERT new claim c3 with referral_id=rx, status=contract_signed: ' || pg_temp.try_as('authenticated', o, format('INSERT INTO public.claims (id,user_id,is_test,status,referral_id) VALUES (%L,%L,true,''contract_signed'',%L)', c3, o, rx));
    v := v || E'\nV1 RESULT ' || pg_temp.acc(rx);
    v := v || E'\nV2 OWNER UPDATE quotes SET claim_id=c3 on the selected quote of c1: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET claim_id=%L WHERE id=%L', c3, q1));
    v := v || E'\nV2 STATE ' || format('quote.claim_id=c3:%s quote.claim_id=c1:%s quote.status=%s total_price=%s', (SELECT claim_id = c3 FROM quotes WHERE id = q1), (SELECT claim_id = c1 FROM quotes WHERE id = q1), (SELECT status FROM quotes WHERE id = q1), (SELECT total_price FROM quotes WHERE id = q1));
    v := v || E'\nV3 service_role (what mark-job-complete does for the contractor) UPDATE c3.completion_date: ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.claims SET completion_date=now() WHERE id=%L', c3));
    v := v || E'\nV3 RESULT ' || pg_temp.acc(rx);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- P: #2519 and the other homeowner writes that must be refused.
  BEGIN
    v := v || E'\nP0 CONTROL stranger UPDATE qs.total_price=99999: ' || pg_temp.try_as('authenticated', stranger, format('UPDATE public.quotes SET total_price=99999 WHERE id=%L', qs));
    v := v || E'\nP1 OWNER UPDATE qs.total_price=99999 (#2519 closes-on): ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET total_price=99999 WHERE id=%L', qs));
    v := v || format(' -> total_price=%s', (SELECT total_price FROM quotes WHERE id = qs));
    v := v || E'\nP2 OWNER UPDATE qs total_price=99999 + status=selected in one statement (refuter V4): ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET total_price=99999, status=''selected'' WHERE id=%L', qs));
    v := v || format(' -> total_price=%s status=%s', (SELECT total_price FROM quotes WHERE id = qs), (SELECT status FROM quotes WHERE id = qs));
    v := v || E'\nP3 OWNER UPDATE q1.status selected -> submitted: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''submitted'' WHERE id=%L', q1));
    v := v || E'\nP3b OWNER UPDATE qs.status submitted -> expired: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''expired'' WHERE id=%L', qs));
    v := v || E'\nP4 OWNER UPDATE qs.contractor_id to another contractor: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET contractor_id=%L WHERE id=%L', k1, qs));
    v := v || E'\nP5 OWNER upsert q1 (INSERT ON CONFLICT (id) DO UPDATE SET claim_id): ' || pg_temp.try_as('authenticated', o, format('INSERT INTO public.quotes (id,claim_id,contractor_id,total_price) VALUES (%L,%L,%L,13560) ON CONFLICT (id) DO UPDATE SET claim_id=excluded.claim_id', q1, cs, k1));
    v := v || E'\nP6 anon UPDATE qs.total_price=99999: ' || pg_temp.try_as('anon', NULL, format('UPDATE public.quotes SET total_price=99999 WHERE id=%L', qs));
    v := v || E'\nP RESULT ' || format('qs total_price=%s status=%s contractor=k2:%s | q1 status=%s claim=c1:%s', (SELECT total_price FROM quotes WHERE id = qs), (SELECT status FROM quotes WHERE id = qs), (SELECT contractor_id = k2 FROM quotes WHERE id = qs), (SELECT status FROM quotes WHERE id = q1), (SELECT claim_id = c1 FROM quotes WHERE id = q1));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- K: contractor writes. K1-K3 are the product's own (contractor-bid-form.html / bid-form.tsx change-bid and
  -- renew payloads, contract-signing.html contractor_signed_at). K4-K5 have no client path.
  BEGIN
    v := v || E'\nK1 LEGIT CONTRACTOR revises own submitted bid qb (total_price, fee, scope, notes, updated_at): ' || pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET total_price=15500, fee_percentage=fee_percentage, fee_amount=fee_amount, scope_summary=''gh2479 proof'', notes=''gh2479 proof'', updated_at=now() WHERE id=%L', qb));
    v := v || format(' -> total_price=%s', (SELECT total_price FROM quotes WHERE id = qb));
    v := v || E'\nK2 CONTRACTOR renewal payload on qb (bid_status=submitted, expires_at, renewals reset; as the client sends it): ' || pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET total_price=15600, bid_status=''submitted'', expired_at=NULL, expires_at=now()+interval ''14 days'' WHERE id=%L', qb));
    v := v || E'\nK2b LEGIT CONTRACTOR renewal payload on qb without bid_status (price, expired_at, expires_at): ' || pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET total_price=15600, expired_at=NULL, expires_at=now()+interval ''14 days'' WHERE id=%L', qb));
    v := v || E'\nK3 LEGIT CONTRACTOR stamps contractor_signed_at on own selected quote q1: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET contractor_signed_at=now() WHERE id=%L', q1));
    v := v || E'\nK4 CONTRACTOR UPDATE own qb.claim_id to another claim: ' || pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET claim_id=%L WHERE id=%L', cs, qb));
    v := v || E'\nK5 CONTRACTOR UPDATE own qb.status=selected (self-award): ' || pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', qb));
    v := v || E'\nK6 CONTROL other contractor UPDATE qb.total_price: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET total_price=1 WHERE id=%L', qb));
    v := v || E'\nK RESULT ' || format('qb total_price=%s status=%s claim=cb:%s | q1 contractor_signed=%s', (SELECT total_price FROM quotes WHERE id = qb), (SELECT status FROM quotes WHERE id = qb), (SELECT claim_id = cb FROM quotes WHERE id = qb), (SELECT contractor_signed_at IS NOT NULL FROM quotes WHERE id = q1));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- H: homeowner writes the product makes. H1 = contract-signing (static and React). H2a-c = the React
  -- award (bids/actions.ts awardClaimToContractor). H3 = a payload that re-sends unchanged values.
  -- Fixture (superuser, inside the savepoint): put a second submitted bid on claim cs, and hand both bids
  -- to contractor k3, who has a payment method on file, so the gh-1532 guard lets the award through.
  BEGIN
    UPDATE public.quotes SET claim_id = cs WHERE id = qb;
    UPDATE public.quotes SET contractor_id = k3 WHERE id IN (qs, qb); -- fixture: k3 has a payment method on file
    v := v || E'\nH1 LEGIT OWNER stamps homeowner_signed_at on q1: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET homeowner_signed_at=now() WHERE id=%L', q1));
    v := v || E'\nH2a OWNER award step 1, claims -> awarded (existing gh-1532 guard, see header): ' || pg_temp.try_as('authenticated', o, format('UPDATE public.claims SET selected_contractor_id=%L, selected_bid_amount=15000, status=''awarded'' WHERE id=%L', k3, cs));
    v := v || E'\nH2b LEGIT OWNER award step 2, winning quote qs -> selected: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', qs));
    v := v || E'\nH2c LEGIT OWNER award step 3, other quotes on the claim -> declined: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''declined'' WHERE claim_id=%L AND id<>%L', cs, qs));
    v := v || E'\nH2 RESULT ' || format('qs=%s qb=%s claim cs=%s', (SELECT status FROM quotes WHERE id = qs), (SELECT status FROM quotes WHERE id = qb), (SELECT status FROM claims WHERE id = cs));
    v := v || E'\nH3 LEGIT OWNER re-sends unchanged claim_id + total_price + contractor_id with the status: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET claim_id=claim_id, contractor_id=contractor_id, total_price=total_price, status=''selected'' WHERE id=%L', qs));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- H4: the static pages accept a bid through the accept_bid() RPC (bids.html, contractor-about.html).
  BEGIN
    UPDATE public.quotes SET claim_id = cs WHERE id = qb;
    UPDATE public.quotes SET contractor_id = k3 WHERE id IN (qs, qb); -- fixture: k3 has a payment method on file
    v := v || E'\nH4 LEGIT OWNER accept_bid(cs, qs) RPC: ' || pg_temp.q_as('authenticated', o, format('SELECT ''quote='' || left(out_quote_id::text,8) || '' amount='' || out_amount || '' declined='' || out_declined_count FROM public.accept_bid(%L,%L)', cs, qs));
    v := v || format(' -> qs=%s qb=%s claim cs=%s', (SELECT status FROM quotes WHERE id = qs), (SELECT status FROM quotes WHERE id = qb), (SELECT status FROM claims WHERE id = cs));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- S: service_role (every Edge Function) is untouched, and the legitimate commission path still accrues.
  BEGIN
    v := v || E'\nS1 LEGIT service_role UPDATE qb total_price + status=expired + claim_id: ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET total_price=15001, status=''expired'', claim_id=%L WHERE id=%L', cs, qb));
    t := pg_temp.q_as('anon', NULL, 'SELECT public.track_referral_click(''8C61OKGF'',''gh2479-quotes-proof'',NULL,NULL,NULL)::text');
    IF t ~ '^[0-9a-f-]{36}$' THEN
      rnew := t::uuid;
      v := v || E'\nS2 LEGIT anon click -> OWNER INSERT new claim c4 with that referral: ' || pg_temp.try_as('authenticated', o, format('INSERT INTO public.claims (id,user_id,is_test,status,referral_id) VALUES (%L,%L,true,''contract_signed'',%L)', c4, o, rnew));
      UPDATE public.quotes SET claim_id = c4 WHERE id = q2; -- fixture (superuser): a selected $15000 quote on c4
      v := v || E'\nS2 LEGIT service_role completion of c4: ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.claims SET completion_date=now() WHERE id=%L', c4));
      v := v || E'\nS2 RESULT ' || pg_temp.acc(rnew);
    ELSE
      v := v || E'\nS2 click returned ' || t;
    END IF;
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- A: referral_agents.agent_type (the column the D-333 no-fee rule reads).
  BEGIN
    v := v || E'\nA1 home_inspector PARTNER UPDATE own agent_type=re_agent: ' || pg_temp.try_as('authenticated', insp_user, format('UPDATE public.referral_agents SET agent_type=''re_agent'' WHERE id=%L', insp_agent));
    v := v || format(' -> agent_type=%s', (SELECT agent_type FROM referral_agents WHERE id = insp_agent));
    v := v || E'\nA2 LEGIT PARTNER profile save (name, phone, bio; agent_type re-sent unchanged): ' || pg_temp.try_as('authenticated', insp_user, format('UPDATE public.referral_agents SET first_name=first_name, phone=''3175550100'', bio=''gh2479 proof'', agent_type=agent_type WHERE user_id=%L', insp_user));
    v := v || E'\nA3 LEGIT ADMIN UPDATE agent_type (admin-referrals setAgentType): ' || pg_temp.try_as('authenticated', o, format('UPDATE public.referral_agents SET agent_type=''other'' WHERE id=%L', insp_agent), 'dustin@otterquote.com');
    v := v || format(' -> agent_type=%s', (SELECT agent_type FROM referral_agents WHERE id = insp_agent));
    v := v || E'\nA4 LEGIT service_role UPDATE agent_type: ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.referral_agents SET agent_type=''home_inspector'' WHERE id=%L', insp_agent));
    v := v || format(' -> agent_type=%s', (SELECT agent_type FROM referral_agents WHERE id = insp_agent));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  RETURN v;
END $s$;

DO $proof$
BEGIN
  RAISE EXCEPTION E'GH2479_QUOTES_FORCED_ROLLBACK%', pg_temp.gh2479_quotes_scenario();
END
$proof$;
