-- gh-2519 / gh-2564 proof: server-set bid fee, column allow-list, one selected bid per claim, the commission
-- bound to the claim's selected contractor (draft gh2519_quotes_server_set_fee.sql) and the price-and-fee lock
-- on a selected bid (draft gh2564_quotes_selected_price_lock.sql).
--
-- THROWAWAY POSTGRES ONLY. This file seeds its own rows; it is NOT the production closes-on run (that one is
-- run by an agent that did not write the change, on is_test rows, in a rolled-back transaction).
-- Schema: supabase/tests/gh2519_gh2564_throwaway_schema.sql (production's tables, policies, grants, functions
-- and triggers for the seven tables this touches, read by SELECT; its header lists what is not loaded).
-- Runner: supabase/tests/gh2519_gh2564_fee_lock_proof_run.sh runs this file five times in one scratch
-- database: TODAY (production's schema), AFTER gh2519, AFTER gh2519+gh2564, after the gh2564 rollback (must
-- equal AFTER gh2519) and after the gh2519 rollback (must equal TODAY, function bodies back at production's).
--
-- How a line is made. Roles are set the way PostgREST sets them (role + request.jwt.claims) and cleared
-- after each statement. Each group runs inside its own savepoint (a block that raises P0U01 and catches
-- it), so no write feeds a later group and the fixtures are identical for every line. NOWRITE at the end
-- compares an md5 over every row of the seven tables before and after.
-- The one fee rate in this file is the production platform_fee_config row, copied (5.00, bid_amount,
-- effective 2026-05-06). Line K4 changes it to 6.00 inside a savepoint to show what a rate change does;
-- 6.00 is a test value, not a proposal.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- ---------- fixtures (idempotent; every row is_test) ----------
INSERT INTO public.platform_fee_config (id, state, trade, fee_pct, fee_basis, effective_date, notes)
VALUES ('fcd50269-f689-42d4-bbc3-8f01e5390c44', NULL, NULL, 5.00, 'bid_amount', DATE '2026-05-06', 'copy of the one production row')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.contractors (id, user_id, company_name, contact_name, email, status, address_state, coi_file_url, coi_expires_at, attestation_accepted_at,
                                has_payment_method, stripe_payment_method_id, stripe_payment_method_last4, is_test)
VALUES ('aaaaaaa1-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'Proof Roofing One',   'K One',   'k1@example.invalid', 'active', 'IN', 'coi.pdf', CURRENT_DATE + 365, now(), true, 'proof-method-1', '4242', true),
       ('aaaaaaa2-0000-4000-8000-000000000002', '44444444-4444-4444-8444-444444444444', 'Proof Roofing Two',   'K Two',   'k2@example.invalid', 'active', 'IN', 'coi.pdf', CURRENT_DATE + 365, now(), true, 'proof-method-2', '4242', true),
       ('aaaaaaa3-0000-4000-8000-000000000003', '55555555-5555-4555-8555-555555555555', 'Proof Roofing Three', 'K Three', 'k3@example.invalid', 'active', 'IN', 'coi.pdf', CURRENT_DATE + 365, now(), true, 'proof-method-3', '4242', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.referral_agents (id, agent_type, first_name, last_name, email, unique_code, status, is_test)
VALUES ('bbbbbbb1-0000-4000-8000-000000000001', 're_agent', 'Proof', 'Referrer', 'referrer@example.invalid', 'PROOF-REF-1', 'active', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.referrals (id, referral_agent_id, status, commission_amount, recruit_commission_amount, is_test, created_at)
VALUES ('ddddddd2-0000-4000-8000-000000000002', 'bbbbbbb1-0000-4000-8000-000000000001', 'claim_submitted', 0, 0, true, now() - interval '5 days'),
       ('ddddddd4-0000-4000-8000-000000000004', 'bbbbbbb1-0000-4000-8000-000000000001', 'claim_submitted', 0, 0, true, now() - interval '5 days')
ON CONFLICT (id) DO NOTHING;

-- c1: open for bids. c2: awarded to k1 at $9,000 (under the floor), k2's $12,000 bid lost. c3: awarded to k1,
-- selected bid $15,000. c4: awarded to k2 at $12,000 (a legitimate job over the floor).
INSERT INTO public.claims (id, user_id, status, ready_for_bids, trades, selected_contractor_id, selected_bid_amount, referral_id, is_test, created_at)
VALUES ('c0000001-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'bidding', true, '{roofing}', NULL, NULL, NULL, true, now() - interval '2 days'),
       ('c0000002-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'awarded', true, '{roofing}', 'aaaaaaa1-0000-4000-8000-000000000001',  9000, 'ddddddd2-0000-4000-8000-000000000002', true, now() - interval '2 days'),
       ('c0000003-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'awarded', true, '{roofing}', 'aaaaaaa1-0000-4000-8000-000000000001', 15000, NULL, true, now() - interval '2 days'),
       ('c0000004-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'awarded', true, '{roofing}', 'aaaaaaa2-0000-4000-8000-000000000002', 12000, 'ddddddd4-0000-4000-8000-000000000004', true, now() - interval '2 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.quotes (id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, platform_fee_pct, platform_fee_basis, status, bid_status,
                           decking_price_per_sheet, full_redeck_price, per_trade_breakdown, trade_type, notes, is_test)
VALUES ('e0000011-0000-4000-8000-000000000011', 'c0000001-0000-4000-8000-000000000001', 'aaaaaaa1-0000-4000-8000-000000000001', 15000, 5.00, 750, 5.00, 'bid_amount', 'submitted', 'active', NULL, NULL, NULL, 'roofing', 'q1', true),
       ('e0000012-0000-4000-8000-000000000012', 'c0000001-0000-4000-8000-000000000001', 'aaaaaaa2-0000-4000-8000-000000000002', 12000, 5.00, 600, NULL, NULL,         'submitted', 'active', NULL, NULL, NULL, 'roofing', 'q2 (legacy row: no platform_fee_pct, like production 0a334300)', true),
       ('e0000021-0000-4000-8000-000000000021', 'c0000002-0000-4000-8000-000000000002', 'aaaaaaa1-0000-4000-8000-000000000001',  9000, 5.00, 450, 5.00, 'bid_amount', 'selected',  'active', NULL, NULL, NULL, 'roofing', 'qw winner', true),
       ('e0000022-0000-4000-8000-000000000022', 'c0000002-0000-4000-8000-000000000002', 'aaaaaaa2-0000-4000-8000-000000000002', 12000, 5.00, 600, 5.00, 'bid_amount', 'declined',  'active', NULL, NULL, NULL, 'roofing', 'ql loser', true),
       ('e0000031-0000-4000-8000-000000000031', 'c0000003-0000-4000-8000-000000000003', 'aaaaaaa1-0000-4000-8000-000000000001', 15000, 5.00, 750, 5.00, 'bid_amount', 'selected',  'active', 80.00, 4000.00, '{"roofing": 15000}', 'roofing', 'qsel', true),
       ('e0000041-0000-4000-8000-000000000041', 'c0000004-0000-4000-8000-000000000004', 'aaaaaaa2-0000-4000-8000-000000000002', 12000, 5.00, 600, 5.00, 'bid_amount', 'selected',  'active', NULL, NULL, NULL, 'roofing', 'q4', true)
ON CONFLICT (id) DO NOTHING;

-- ---------- helpers ----------
CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_sql text, p_email text DEFAULT 'fee-lock-proof@example.invalid') RETURNS text
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
    PERFORM set_config('request.jwt.claims', '', true);
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row changed)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 110);
  END;
END $f$;

CREATE FUNCTION pg_temp.count_as(p_role text, p_sub uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role, 'email', 'fee-lock-proof@example.invalid')::text, true);
  PERFORM set_config('role', p_role, true);
  EXECUTE p_sql INTO v;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN COALESCE(v, 'NULL');
END $f$;

-- what is stored on a quote, read as the table owner
CREATE FUNCTION pg_temp.st(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT COALESCE((SELECT format(' -> price=%s rate=%s fee_percentage=%s basis=%s fee_amount=%s status=%s',
            total_price, COALESCE(platform_fee_pct::text, 'NULL'), fee_percentage, COALESCE(platform_fee_basis, 'NULL'), fee_amount, status)
       FROM public.quotes WHERE id = p_id), ' -> (no such row)');
$f$;

-- who a claim is awarded to, and how many bids on it are selected (any bid_status / selected AND active)
CREATE FUNCTION pg_temp.sel(p_claim uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT format(' | claim status=%s selected_contractor=%s selected_bid_amount=%s | selected bids (any bid_status)=%s, selected AND active=%s',
    c.status, CASE WHEN c.selected_contractor_id IS NULL THEN 'none' WHEN c.selected_contractor_id = 'aaaaaaa1-0000-4000-8000-000000000001'::uuid THEN 'k1' WHEN c.selected_contractor_id = 'aaaaaaa2-0000-4000-8000-000000000002'::uuid THEN 'k2' ELSE 'other' END,
    COALESCE(c.selected_bid_amount::text, 'NULL'),
    (SELECT count(*) FROM public.quotes WHERE claim_id = p_claim AND status = 'selected'),
    (SELECT count(*) FROM public.quotes WHERE claim_id = p_claim AND status = 'selected' AND bid_status = 'active'))
  FROM public.claims c WHERE c.id = p_claim;
$f$;

-- complete a claim the way mark-job-complete does (service side) and report what the referral accrued
CREATE FUNCTION pg_temp.complete(p_claim uuid) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  UPDATE public.claims SET completion_date = now() WHERE id = p_claim;
  SELECT format('commission=%s job_value=%s payout_approvals rows=%s',
           COALESCE(NULLIF(r.commission_amount, 0)::text, 'null'), COALESCE(r.job_value::text, 'null'),
           (SELECT count(*) FROM public.payout_approvals p WHERE p.referral_id = r.id))
    INTO v FROM public.claims c JOIN public.referrals r ON r.id = c.referral_id WHERE c.id = p_claim;
  RETURN v;
END $f$;

CREATE FUNCTION pg_temp.snap() RETURNS text LANGUAGE sql AS $f$
  SELECT left(md5(string_agg(x, '|' ORDER BY x)), 8) FROM (
    SELECT 'q' || row_to_json(t)::text x FROM public.quotes t UNION ALL
    SELECT 'c' || row_to_json(t)::text FROM public.claims t UNION ALL
    SELECT 'k' || row_to_json(t)::text FROM public.contractors t UNION ALL
    SELECT 'f' || row_to_json(t)::text FROM public.platform_fee_config t UNION ALL
    SELECT 'r' || row_to_json(t)::text FROM public.referrals t UNION ALL
    SELECT 'a' || row_to_json(t)::text FROM public.referral_agents t UNION ALL
    SELECT 'p' || row_to_json(t)::text FROM public.payout_approvals t) s;
$f$;

CREATE FUNCTION pg_temp.fee_lock_scenario() RETURNS text
LANGUAGE plpgsql AS $s$
DECLARE
  o   constant uuid := '11111111-1111-4111-8111-111111111111'; -- homeowner, owns c1..c4
  x   constant uuid := '22222222-2222-4222-8222-222222222222'; -- a stranger (signed in, owns nothing)
  k1u constant uuid := '33333333-3333-4333-8333-333333333333'; k1 constant uuid := 'aaaaaaa1-0000-4000-8000-000000000001';
  k2u constant uuid := '44444444-4444-4444-8444-444444444444'; k2 constant uuid := 'aaaaaaa2-0000-4000-8000-000000000002';
  k3u constant uuid := '55555555-5555-4555-8555-555555555555'; k3 constant uuid := 'aaaaaaa3-0000-4000-8000-000000000003';
  c1 constant uuid := 'c0000001-0000-4000-8000-000000000001'; c2 constant uuid := 'c0000002-0000-4000-8000-000000000002';
  c3 constant uuid := 'c0000003-0000-4000-8000-000000000003'; c4 constant uuid := 'c0000004-0000-4000-8000-000000000004';
  q1 constant uuid := 'e0000011-0000-4000-8000-000000000011'; -- c1, k1, submitted, 15000, rate 5.00, fee 750.00
  q2 constant uuid := 'e0000012-0000-4000-8000-000000000012'; -- c1, k2, submitted, 12000, rate NULL (legacy), fee 600.00
  qw constant uuid := 'e0000021-0000-4000-8000-000000000021'; -- c2, k1, SELECTED,   9000 (the winner, under the floor)
  ql constant uuid := 'e0000022-0000-4000-8000-000000000022'; -- c2, k2, declined,  12000 (the loser, over the floor)
  qs constant uuid := 'e0000031-0000-4000-8000-000000000031'; -- c3, k1, SELECTED,  15000, decking 80.00, redeck 4000.00
  q4 constant uuid := 'e0000041-0000-4000-8000-000000000041'; -- c4, k2, SELECTED,  12000 (legitimate winner over the floor)
  n1 constant uuid := 'e00000f1-0000-4000-8000-0000000000f1'; -- id of the bid the INSERT lines create
  ins_cols constant text := '(id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, scope_summary, notes, decking_price_per_sheet, full_redeck_price, supplement_acknowledged, trade_type, value_adds, per_trade_breakdown, is_auto_bid, auto_renew, warranty_option_id, warranty_snapshot, workmanship_warranty_years, platform_fee_pct, platform_fee_basis, fee_accepted_at)';
  -- the change-bid payload both forms send (contractor-bid-form.html _changeBidPayload, utils.ts buildQuoteUpdate)
  upd_tail constant text := ', fee_accepted_at=now(), scope_summary=''scope'', notes=''revised'', decking_price_per_sheet=NULL, full_redeck_price=NULL, supplement_acknowledged=false, trade_type=''roofing'', value_adds=''{}''::jsonb, per_trade_breakdown=NULL, auto_renew=true, warranty_option_id=NULL, warranty_snapshot=NULL, workmanship_warranty_years=NULL, updated_at=now()';
  before text; v text := '';
BEGIN
  before := pg_temp.snap();
  v := v || E'\nGUARDS ' || format('guard_triggers_on_quotes=%s guard_md5=%s commission_md5=%s server_sets_fee=%s second_selected_rule=%s allow_list=%s lock_gh2564=%s helper_quotes_platform_fee_for=%s commission_reads_selected_contractor=%s accept_bid_md5=%s accept_bid_refuses_second=%s lock_terms_d381=%s one_selected_index=%s accept_bid_claim_lock_first=%s',
    (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND tgname LIKE '%guard%' AND NOT tgisinternal),
    (SELECT left(md5(prosrc), 8) FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure),
    (SELECT left(md5(prosrc), 8) FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure),
    (SELECT prosrc LIKE '%quotes_platform_fee_for(NEW.contractor_id%' FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure),
    (SELECT prosrc LIKE '%a second bid cannot be selected beside it%' FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure),
    (SELECT prosrc LIKE '%v_allowed%' FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure),
    (SELECT prosrc LIKE '%(gh-2564)%' FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure),
    (SELECT count(*) FROM pg_proc WHERE proname = 'quotes_platform_fee_for' AND pronamespace = 'public'::regnamespace),
    (SELECT prosrc LIKE '%contractor_id = NEW.selected_contractor_id%' FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure),
    (SELECT left(md5(prosrc), 8) FROM pg_proc WHERE oid = 'public.accept_bid(uuid,uuid)'::regprocedure),
    (SELECT prosrc LIKE '%a second bid cannot be selected beside it%' FROM pg_proc WHERE oid = 'public.accept_bid(uuid,uuid)'::regprocedure),
    (SELECT prosrc LIKE '%NEW.scope_summary IS DISTINCT FROM OLD.scope_summary%' FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure),
    (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'quotes_one_selected_bid_per_claim'),
    (SELECT prosrc LIKE '%FOR NO KEY UPDATE%' FROM pg_proc WHERE oid = 'public.accept_bid(uuid,uuid)'::regprocedure));
  v := v || E'\nCFG   ' || format('platform_fee_config rows=%s | row for (contractor state IN, trade roofing): fee_pct=%s fee_basis=%s | rows a signed-in contractor can read through RLS=%s',
    (SELECT count(*) FROM public.platform_fee_config),
    (SELECT fee_pct FROM public.platform_fee_config WHERE state IS NULL AND trade IS NULL), (SELECT fee_basis FROM public.platform_fee_config WHERE state IS NULL AND trade IS NULL),
    pg_temp.count_as('authenticated', k1u, 'SELECT count(*) FROM public.platform_fee_config'));

  -- ===== I: a new bid (INSERT) =====
  BEGIN
    v := v || E'\nI1 CONTRACTOR k3 INSERT, the bid forms'' 21 columns (plus an id to read the row back), honest values (20000, fee_percentage 5.0, fee_amount 1000, platform_fee_pct 5, bid_amount): '
      || pg_temp.try_as('authenticated', k3u, format('INSERT INTO public.quotes %s VALUES (%L,%L,%L, 20000, 5.0, 1000, ''scope'', NULL, NULL, NULL, false, ''roofing'', ''{}''::jsonb, NULL, false, true, NULL, NULL, NULL, 5, ''bid_amount'', now())', ins_cols, n1, c1, k3)) || pg_temp.st(n1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nI2 CONTRACTOR k3 INSERT, same columns, sends platform_fee_pct=0 fee_percentage=0 fee_amount=0 platform_fee_basis=other: '
      || pg_temp.try_as('authenticated', k3u, format('INSERT INTO public.quotes %s VALUES (%L,%L,%L, 20000, 0, 0, ''scope'', NULL, NULL, NULL, false, ''roofing'', ''{}''::jsonb, NULL, false, true, NULL, NULL, NULL, 0, ''other'', now())', ins_cols, n1, c1, k3)) || pg_temp.st(n1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nI3 CONTRACTOR k3 INSERT born is_test=true: '
      || pg_temp.try_as('authenticated', k3u, format('INSERT INTO public.quotes (id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, platform_fee_pct, platform_fee_basis, is_test) VALUES (%L,%L,%L, 20000, 5, 1000, 5, ''bid_amount'', true)', n1, c1, k3));
    v := v || format(' -> is_test=%s', COALESCE((SELECT is_test::text FROM public.quotes WHERE id = n1), '(no such row)'));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nI4 CONTRACTOR k3 INSERT born with payment_intent_id: '
      || pg_temp.try_as('authenticated', k3u, format('INSERT INTO public.quotes (id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, platform_fee_pct, platform_fee_basis, payment_intent_id) VALUES (%L,%L,%L, 20000, 5, 1000, 5, ''bid_amount'', ''forged-intent'')', n1, c1, k3));
    v := v || format(' -> payment_intent_id=%s', COALESCE((SELECT payment_intent_id FROM public.quotes WHERE id = n1), '(none)'));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    DELETE FROM public.platform_fee_config; -- fixture: no config row at all
    v := v || E'\nI5 CONTRACTOR k3 INSERT when platform_fee_config has no row (sends 5 / 1000): '
      || pg_temp.try_as('authenticated', k3u, format('INSERT INTO public.quotes %s VALUES (%L,%L,%L, 20000, 5.0, 1000, ''scope'', NULL, NULL, NULL, false, ''roofing'', ''{}''::jsonb, NULL, false, true, NULL, NULL, NULL, 5, ''bid_amount'', now())', ins_cols, n1, c1, k3)) || pg_temp.st(n1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nI6 CONTROL stranger INSERT a bid naming contractor k3: '
      || pg_temp.try_as('authenticated', x, format('INSERT INTO public.quotes %s VALUES (%L,%L,%L, 20000, 5.0, 1000, ''scope'', NULL, NULL, NULL, false, ''roofing'', ''{}''::jsonb, NULL, false, true, NULL, NULL, NULL, 5, ''bid_amount'', now())', ins_cols, n1, c1, k3)) || pg_temp.st(n1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- ===== K: the bid's own contractor revises a bid that is not yet selected (UPDATE) =====
  BEGIN
    v := v || E'\nK1 CONTRACTOR k1 UPDATE q1 SET platform_fee_pct = 4 (closes-on line; negative control K1 of 6023724531): '
      || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET platform_fee_pct = 4 WHERE id = %L', q1)) || pg_temp.st(q1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nK2 CONTRACTOR k1 change-bid payload on q1, honest (15500, fee_percentage 5.0, fee_amount 775, platform_fee_pct 5, bid_amount) = L1: '
      || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET total_price=15500, fee_percentage=5.0, fee_amount=775, platform_fee_pct=5, platform_fee_basis=''bid_amount''%s WHERE id = %L', upd_tail, q1)) || pg_temp.st(q1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nK3 CONTRACTOR k1 change-bid payload on q1 with fee_percentage=1 fee_amount=1 platform_fee_pct=1 platform_fee_basis=other at 15500: '
      || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET total_price=15500, fee_percentage=1, fee_amount=1, platform_fee_pct=1, platform_fee_basis=''other''%s WHERE id = %L', upd_tail, q1)) || pg_temp.st(q1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    UPDATE public.platform_fee_config SET fee_pct = 6.00; -- fixture: the configured rate changes while q1 is open (6.00 is a test value)
    v := v || E'\nK4 TIER C POINT, config changed to 6.00 while q1 is open; k1 revises q1 to 16000 sending platform_fee_pct=6: '
      || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET total_price=16000, fee_percentage=5.0, fee_amount=800, platform_fee_pct=6, platform_fee_basis=''bid_amount''%s WHERE id = %L', upd_tail, q1)) || pg_temp.st(q1);
    v := v || E'\nK4b same config (6.00); k3 submits a NEW bid of 20000 sending platform_fee_pct=5: '
      || pg_temp.try_as('authenticated', k3u, format('INSERT INTO public.quotes %s VALUES (%L,%L,%L, 20000, 5.0, 1000, ''scope'', NULL, NULL, NULL, false, ''roofing'', ''{}''::jsonb, NULL, false, true, NULL, NULL, NULL, 5, ''bid_amount'', now())', ins_cols, n1, c1, k3)) || pg_temp.st(n1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nK5 CONTRACTOR k2 revises legacy bid q2 (stored rate NULL) to 13000 sending platform_fee_pct=2 fee_amount=1: '
      || pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET total_price=13000, fee_amount=1, platform_fee_pct=2 WHERE id = %L', q2)) || pg_temp.st(q2);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- ===== C: the columns no page writes (residual 3) =====
  BEGIN
    v := v || E'\nC1 OWNER UPDATE q1 SET payment_status = ''refunded'' (closes-on line): '
      || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET payment_status = ''refunded'' WHERE id = %L', q1));
    v := v || format(' -> payment_status=%s', COALESCE((SELECT payment_status FROM public.quotes WHERE id = q1), 'NULL'));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nC2 OWNER UPDATE q1 SET is_test = false (closes-on line; fixture rows are is_test = true): '
      || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET is_test = false WHERE id = %L', q1));
    v := v || format(' -> is_test=%s', (SELECT is_test FROM public.quotes WHERE id = q1));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nC3 OWNER UPDATE q1 SET payment_intent_id, fee_accepted_at, bid_status = ''cancelled'': '
      || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET payment_intent_id = ''forged-intent'', fee_accepted_at = now(), bid_status = ''cancelled'' WHERE id = %L', q1));
    v := v || format(' -> payment_intent_id=%s bid_status=%s', COALESCE((SELECT payment_intent_id FROM public.quotes WHERE id = q1), 'NULL'), (SELECT bid_status FROM public.quotes WHERE id = q1));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nC4 CONTRACTOR k1 UPDATE own q1 SET is_test = false, payment_status = ''succeeded'': '
      || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET is_test = false, payment_status = ''succeeded'' WHERE id = %L', q1));
    v := v || format(' -> is_test=%s payment_status=%s', (SELECT is_test FROM public.quotes WHERE id = q1), COALESCE((SELECT payment_status FROM public.quotes WHERE id = q1), 'NULL'));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nC5 CONTRACTOR k1 UPDATE own q1 SET bid_status = ''expired'', expires_at (columns the renewal payload sends): '
      || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET bid_status = ''expired'', expires_at = now() + interval ''14 days'' WHERE id = %L', q1));
    v := v || format(' -> bid_status=%s', (SELECT bid_status FROM public.quotes WHERE id = q1));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nC6 OWNER stamps contractor_signed_at on q1 (the contractor''s stamp): '
      || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET contractor_signed_at = now() WHERE id = %L', q1));
    v := v || format(' -> contractor_signed_at set=%s', (SELECT contractor_signed_at IS NOT NULL FROM public.quotes WHERE id = q1));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- ===== F / P / L: lines of 6023724531 that must read the same before and after =====
  BEGIN
    v := v || E'\nF0 CONTROL stranger UPDATE q1.fee_amount=0: ' || pg_temp.try_as('authenticated', x, format('UPDATE public.quotes SET fee_amount=0 WHERE id=%L', q1));
    v := v || E'\nF2 OWNER UPDATE q1.platform_fee_pct=0: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET platform_fee_pct=0 WHERE id=%L', q1)) || pg_temp.st(q1);
    v := v || E'\nP1 OWNER UPDATE q1.total_price=99999: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET total_price=99999 WHERE id=%L', q1)) || pg_temp.st(q1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nL3 LEGIT OWNER award: q1 status=selected with the fee columns re-sent unchanged: '
      || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET fee_amount=fee_amount, fee_percentage=fee_percentage, platform_fee_pct=platform_fee_pct, platform_fee_basis=platform_fee_basis, status=''selected'' WHERE id=%L', q1));
    v := v || E'\nL4 LEGIT OWNER declines every other bid on c1 (the React award''s third write): '
      || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''declined'' WHERE claim_id=%L AND id<>%L', c1, q1));
    v := v || E'\nL5 LEGIT OWNER stamps homeowner_signed_at on q1: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET homeowner_signed_at=now() WHERE id=%L', q1));
    v := v || E'\nL5b LEGIT CONTRACTOR k1 stamps contractor_signed_at on q1: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET contractor_signed_at=now() WHERE id=%L', q1));
    v := v || format(' -> q1 status=%s q2 status=%s signed(h,c)=%s,%s', (SELECT status FROM public.quotes WHERE id = q1), (SELECT status FROM public.quotes WHERE id = q2),
           (SELECT homeowner_signed_at IS NOT NULL FROM public.quotes WHERE id = q1), (SELECT contractor_signed_at IS NOT NULL FROM public.quotes WHERE id = q1));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nL6 LEGIT service_role UPDATE q1.platform_fee_pct=6, payment_status=pending: ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET platform_fee_pct=6, payment_status=''pending'' WHERE id=%L', q1)) || pg_temp.st(q1);
    v := v || E'\nL7 LEGIT ADMIN UPDATE q1.platform_fee_pct=7, is_test=false (admin email): ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET platform_fee_pct=7, is_test=false WHERE id=%L', q1), 'dustin@otterquote.com') || pg_temp.st(q1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nL8 LEGIT accept_bid(c1, q1) as the owner: ' || pg_temp.try_as('authenticated', o, format('SELECT * FROM public.accept_bid(%L, %L)', c1, q1));
    v := v || format(' -> q1=%s q2=%s claim c1=%s selected_contractor=k1:%s selected_bid_amount=%s fee_amount=%s', (SELECT status FROM public.quotes WHERE id = q1), (SELECT status FROM public.quotes WHERE id = q2),
           (SELECT status FROM public.claims WHERE id = c1), (SELECT selected_contractor_id = k1 FROM public.claims WHERE id = c1), (SELECT selected_bid_amount FROM public.claims WHERE id = c1), (SELECT fee_amount FROM public.quotes WHERE id = q1));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- ===== E: a second selected bid, and the $10,000 commission floor (residual 4) =====
  BEGIN
    v := v || E'\nE4 OWNER sets the losing $12,000 bid ql to selected beside the $9,000 winner qw (closes-on line; E4 of 6000637783): '
      || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', ql));
    v := v || format(' -> qw=%s ql=%s', (SELECT status FROM public.quotes WHERE id = qw), (SELECT status FROM public.quotes WHERE id = ql));
    v := v || E'\nE4  ... then the job on c2 is completed (service side): ' || pg_temp.complete(c2);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    DROP INDEX IF EXISTS public.quotes_one_selected_bid_per_claim; -- fixture, undone with the savepoint: with the index in place (N1) this state cannot be built, so the commission function is tested alone
    UPDATE public.quotes SET status = 'selected', updated_at = now() + interval '1 minute' WHERE id = ql; -- fixture (table owner): the second selected bid exists by SOME route
    v := v || E'\nE4b second selected bid forced in by the table owner, then c2 completed (the commission function alone): ' || pg_temp.complete(c2);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nE4c CONTROL no second bid: c2 completed with only the $9,000 winner selected: ' || pg_temp.complete(c2);
    v := v || E'\nE4d CONTROL a legitimate job over the floor: c4 (awarded to k2 at $12,000) completed: ' || pg_temp.complete(c4);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nE5 OWNER selects both bids on c1 in one statement: '
      || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''selected'' WHERE claim_id=%L', c1));
    v := v || format(' -> selected bids on c1=%s', (SELECT count(*) FROM public.quotes WHERE claim_id = c1 AND status = 'selected'));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nR1 RESIDUAL (not closed by these drafts) OWNER declines the winner qw: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''declined'' WHERE id=%L', qw));
    v := v || E'\nR1  ... selects the $12,000 bid ql: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', ql));
    v := v || E'\nR1  ... repoints claims.selected_contractor_id to k2: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.claims SET selected_contractor_id=%L, selected_bid_amount=12000 WHERE id=%L', k2, c2));
    v := v || E'\nR1  ... then c2 is completed: ' || pg_temp.complete(c2);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- ===== X: the second award route, rpc accept_bid() (review 6050036561 B1; CEO ruling 6050104316) =====
  BEGIN
    v := v || E'\nX1a before: c2 is awarded to k1 (qw selected at 9000), ql is k2''s declined 12000 bid';
    v := v || E'\nX1b CONTROL OWNER direct UPDATE ql SET status=selected (the route E4 proves): '
      || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', ql));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nX1c OWNER rpc accept_bid(c2, ql), the losing $12,000 bid, beside the selected winner qw: '
      || pg_temp.try_as('authenticated', o, format('SELECT * FROM public.accept_bid(%L, %L)', c2, ql));
    v := v || format(' -> qw=%s ql=%s | claim.selected_contractor=%s | selected bids on c2=%s', (SELECT status FROM public.quotes WHERE id = qw), (SELECT status FROM public.quotes WHERE id = ql),
           (SELECT CASE selected_contractor_id WHEN k1 THEN 'k1' WHEN k2 THEN 'k2' ELSE 'other' END FROM public.claims WHERE id = c2),
           (SELECT count(*) FROM public.quotes WHERE claim_id = c2 AND status = 'selected'));
    v := v || E'\nX1d  ... then c2 is completed (service side): ' || pg_temp.complete(c2);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nX2 CONTROL OWNER rpc accept_bid(c2, qw), the bid that is already the selected one (a repeated click): '
      || pg_temp.try_as('authenticated', o, format('SELECT * FROM public.accept_bid(%L, %L)', c2, qw));
    v := v || format(' -> qw=%s ql=%s', (SELECT status FROM public.quotes WHERE id = qw), (SELECT status FROM public.quotes WHERE id = ql));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nX3 CONTROL STRANGER rpc accept_bid(c2, ql) on a claim the caller does not own: '
      || pg_temp.try_as('authenticated', x, format('SELECT * FROM public.accept_bid(%L, %L)', c2, ql));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  BEGIN
    UPDATE public.claims SET status = 'contract_signed' WHERE id = c3; -- fixture: the contract on c3 is signed
    v := v || E'\nX2b CONTROL OWNER rpc accept_bid(c3, qs), the live selected bid, on a claim whose contract is signed (a repeated click; before: the claim is rewound to awarded): '
      || pg_temp.try_as('authenticated', o, format('SELECT * FROM public.accept_bid(%L, %L)', c3, qs)) || pg_temp.sel(c3);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- ===== W: the claim after the platform's first exit, switch-contractor (re-review 6051423781 finding 1) =====
  -- switch-contractor step 6 writes quotes.status = 'cancelled' (refused by quotes_status_check, logged "Non-fatal"), then
  -- step 7 resets the claim to bidding with no selected contractor. The old bid stays selected.
  BEGIN
    v := v || E'\nW1 CONTROL switch-contractor step 6 as service_role, quotes.status=cancelled on the winner qw (quotes_status_check allows only draft, submitted, selected, declined, expired): '
      || pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET status=''cancelled'', cancelled_at=now(), cancellation_reason=''homeowner_switched_contractor'' WHERE id=%L', qw)) || pg_temp.st(qw);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    UPDATE public.quotes SET status = 'submitted', updated_at = now() WHERE id = ql; -- fixture: k2's bid on c2 is open
    v := v || E'\nW2 switch-contractor step 7 as service_role, claim c2 reset (status bidding, selected_contractor_id NULL; qw stays selected): '
      || pg_temp.try_as('service_role', NULL, format('UPDATE public.claims SET status=''bidding'', selected_contractor_id=NULL, contractor_switched_at=now(), contractor_switch_count=contractor_switch_count+1 WHERE id=%L', c2)) || pg_temp.sel(c2);
    v := v || E'\nW3 OWNER rpc accept_bid(c2, ql) after the switch (the homeowner awards another bid; before: two selected bids, after the previous head: refused and the claim stuck in bidding): '
      || pg_temp.try_as('authenticated', o, format('SELECT * FROM public.accept_bid(%L, %L)', c2, ql)) || pg_temp.sel(c2);
    v := v || format(' | qw=%s ql=%s', (SELECT status FROM public.quotes WHERE id = qw), (SELECT status FROM public.quotes WHERE id = ql));
    v := v || E'\nW3b  ... then c2 is completed (service side; the commission follows the claim''s selected contractor k2): ' || pg_temp.complete(c2);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nW4 RESIDUAL OWNER the React award shape on c2 (claim stays awarded; react-app bids/actions.ts writes claims, then quotes): UPDATE claims to k2, then UPDATE quotes SET status=selected on ql. The same repoint R1 shows; before: two selected bids; after the previous head: the second write refused and the claim left naming k2 with k2''s bid unselected: '
      || pg_temp.try_as('authenticated', o, format('UPDATE public.claims SET selected_contractor_id=%L, selected_bid_amount=12000, status=''awarded'' WHERE id=%L', k2, c2))
      || ' / ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', ql)) || pg_temp.sel(c2);
    v := v || format(' | qw=%s ql=%s', (SELECT status FROM public.quotes WHERE id = qw), (SELECT status FROM public.quotes WHERE id = ql));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- ===== RB: the claim after the platform's second exit, rescind-bid, and the re-bid (D-369's way out) =====
  -- rescind-bid writes quotes.bid_status = 'rescinded', which quotes_bid_status_check refuses, and leaves status selected.
  -- 'cancelled' is the nearest value the constraint allows: what a repaired rescind-bid would have to write.
  BEGIN
    v := v || E'\nRB1 CONTROL rescind-bid''s own write as service_role, bid_status=rescinded on the selected bid qs (quotes_bid_status_check allows only active, expired, superseded, cancelled): '
      || pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET bid_status=''rescinded'', updated_at=now() WHERE id=%L', qs));
    v := v || format(' -> bid_status=%s', (SELECT bid_status FROM public.quotes WHERE id = qs));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nRB2 rescind (service_role, bid_status=cancelled on qs), k1 re-bids 14000 on c3, OWNER rpc accept_bid(c3, new bid): '
      || pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET bid_status=''cancelled'', updated_at=now() WHERE id=%L', qs))
      || ' / ' || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.quotes %s VALUES (%L,%L,%L, 14000, 5.0, 700, ''scope'', NULL, NULL, NULL, false, ''roofing'', ''{}''::jsonb, NULL, false, true, NULL, NULL, NULL, 5, ''bid_amount'', now())', ins_cols, n1, c3, k1))
      || ' / ' || pg_temp.try_as('authenticated', o, format('SELECT * FROM public.accept_bid(%L, %L)', c3, n1)) || pg_temp.sel(c3);
    v := v || format(' | qs=%s/%s new=%s/%s', (SELECT status FROM public.quotes WHERE id = qs), (SELECT bid_status FROM public.quotes WHERE id = qs), (SELECT status FROM public.quotes WHERE id = n1), (SELECT bid_status FROM public.quotes WHERE id = n1));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nRB3 CONTROL no rescind: k1 re-bids 14000 on c3 while qs is still the live selected bid, OWNER rpc accept_bid(c3, new bid): '
      || pg_temp.try_as('authenticated', k1u, format('INSERT INTO public.quotes %s VALUES (%L,%L,%L, 14000, 5.0, 700, ''scope'', NULL, NULL, NULL, false, ''roofing'', ''{}''::jsonb, NULL, false, true, NULL, NULL, NULL, 5, ''bid_amount'', now())', ins_cols, n1, c3, k1))
      || ' / ' || pg_temp.try_as('authenticated', o, format('SELECT * FROM public.accept_bid(%L, %L)', c3, n1)) || pg_temp.sel(c3);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- ===== I2: the partial unique index quotes_one_selected_bid_per_claim, every route that skips the guard =====
  BEGIN
    v := v || E'\nN1 service_role selects q1 then q2 on c1 in two statements (the guard does not apply to service_role; the SQL editor and Edge Functions are the same): '
      || pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', q1))
      || ' / ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', q2)) || pg_temp.sel(c1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nN2 CONTROL service_role selects q1, q1 is rescinded (bid_status=cancelled), q2 is selected: '
      || pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', q1))
      || ' / ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET bid_status=''cancelled'' WHERE id=%L', q1))
      || ' / ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', q2)) || pg_temp.sel(c1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- ===== S: the selected bid qs (gh-2564, D-369) =====
  BEGIN
    v := v || E'\nS0 CONTROL contractor k1 UPDATE total_price=15500 on q1, NOT yet selected: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET total_price=15500 WHERE id=%L', q1)) || pg_temp.st(q1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nS1 CONTRACTOR k1 UPDATE total_price=15500 on qs, SELECTED: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET total_price=15500 WHERE id=%L', qs)) || pg_temp.st(qs);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nS2 CONTRACTOR k1 change-bid payload on qs, SELECTED, new price 14000 (what "Update Bid" sends today): '
      || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET total_price=14000, fee_percentage=5.0, fee_amount=700, platform_fee_pct=5, platform_fee_basis=''bid_amount''%s WHERE id = %L', upd_tail, qs)) || pg_temp.st(qs);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nS3 CONTRACTOR k1 UPDATE platform_fee_pct=4, fee_amount=1 on qs, SELECTED: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET platform_fee_pct=4, fee_amount=1 WHERE id=%L', qs)) || pg_temp.st(qs);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nS4 CONTRACTOR k1 UPDATE decking_price_per_sheet=95 on qs, SELECTED: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET decking_price_per_sheet=95 WHERE id=%L', qs));
    v := v || format(' -> decking_price_per_sheet=%s', (SELECT decking_price_per_sheet FROM public.quotes WHERE id = qs));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nS5 CONTRACTOR k1 UPDATE full_redeck_price=9000 on qs, SELECTED: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET full_redeck_price=9000 WHERE id=%L', qs));
    v := v || format(' -> full_redeck_price=%s', (SELECT full_redeck_price FROM public.quotes WHERE id = qs));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nS6 CONTRACTOR k1 UPDATE per_trade_breakdown on qs, SELECTED: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET per_trade_breakdown=''{"roofing": 1}''::jsonb WHERE id=%L', qs));
    v := v || format(' -> per_trade_breakdown=%s', (SELECT per_trade_breakdown FROM public.quotes WHERE id = qs));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nS7 OWNER UPDATE total_price=1 on qs, SELECTED: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET total_price=1 WHERE id=%L', qs)) || pg_temp.st(qs);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  -- ===== T: the terms of a selected bid (D-381, extends D-369: trade, warranty, value-adds, and scope) =====
  BEGIN
    v := v || E'\nT0 CONTROL contractor k1 UPDATE trade_type, value_adds, workmanship_warranty_years, warranty_option_id, warranty_snapshot, scope_summary on q1, NOT yet selected: '
      || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET trade_type=''siding'', value_adds=''{"gutters": true}''::jsonb, workmanship_warranty_years=10, warranty_option_id=%L, warranty_snapshot=''ten years'', scope_summary=''new scope'' WHERE id=%L', gen_random_uuid(), q1))
      || format(' -> trade_type=%s workmanship_warranty_years=%s', (SELECT trade_type FROM public.quotes WHERE id = q1), (SELECT workmanship_warranty_years FROM public.quotes WHERE id = q1));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nT1 CONTRACTOR k1 UPDATE trade_type=siding on qs, SELECTED: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET trade_type=''siding'' WHERE id=%L', qs))
      || format(' -> trade_type=%s', (SELECT trade_type FROM public.quotes WHERE id = qs));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nT2 CONTRACTOR k1 UPDATE value_adds on qs, SELECTED: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET value_adds=''{"gutters": true}''::jsonb WHERE id=%L', qs))
      || format(' -> value_adds=%s', COALESCE((SELECT value_adds::text FROM public.quotes WHERE id = qs), 'NULL'));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nT3 CONTRACTOR k1 UPDATE workmanship_warranty_years=10 on qs, SELECTED: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET workmanship_warranty_years=10 WHERE id=%L', qs))
      || format(' -> workmanship_warranty_years=%s', COALESCE((SELECT workmanship_warranty_years::text FROM public.quotes WHERE id = qs), 'NULL'));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nT4 CONTRACTOR k1 UPDATE warranty_option_id on qs, SELECTED: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET warranty_option_id=%L WHERE id=%L', gen_random_uuid(), qs))
      || format(' -> warranty_option_id set=%s', (SELECT warranty_option_id IS NOT NULL FROM public.quotes WHERE id = qs));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nT5 CONTRACTOR k1 UPDATE warranty_snapshot on qs, SELECTED: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET warranty_snapshot=''lifetime'' WHERE id=%L', qs))
      || format(' -> warranty_snapshot=%s', COALESCE((SELECT warranty_snapshot FROM public.quotes WHERE id = qs), 'NULL'));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nT6 CONTRACTOR k1 UPDATE scope_summary on qs, SELECTED: ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET scope_summary=''new scope'' WHERE id=%L', qs))
      || format(' -> scope_summary=%s', COALESCE((SELECT scope_summary FROM public.quotes WHERE id = qs), 'NULL'));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nT7 CONTRACTOR k1 change-bid payload on qs, SELECTED, price and fee re-sent unchanged, one term changed (value_adds): '
      || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET total_price=15000, fee_percentage=5.0, fee_amount=750, platform_fee_pct=5, platform_fee_basis=''bid_amount'', fee_accepted_at=now(), notes=''revised'', trade_type=''roofing'', value_adds=''{"gutters": true}''::jsonb, scope_summary=NULL, decking_price_per_sheet=80.00, full_redeck_price=4000.00, per_trade_breakdown=''{"roofing": 15000}''::jsonb, updated_at=now() WHERE id = %L', qs));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nT8 LEGIT service_role UPDATE trade_type=siding, value_adds on qs, SELECTED (a rescind-and-rebid fix, an Edge Function): '
      || pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET trade_type=''siding'', value_adds=''{"gutters": true}''::jsonb WHERE id=%L', qs));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nT9 LEGIT ADMIN UPDATE scope_summary on qs, SELECTED: '
      || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET scope_summary=''admin fix'' WHERE id=%L', qs), 'dustin@otterquote.com');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nS8 LEGIT CONTRACTOR k1 edits notes only on qs, SELECTED (price and fee re-sent unchanged): '
      || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET total_price=15000, fee_percentage=5.0, fee_amount=750, platform_fee_pct=5, platform_fee_basis=''bid_amount'', notes=''start date moved'', updated_at=now() WHERE id=%L', qs));
    v := v || format(' -> notes=%s', (SELECT notes FROM public.quotes WHERE id = qs)) || pg_temp.st(qs);
    v := v || E'\nS9 LEGIT signature stamps on qs, SELECTED (owner, then contractor): ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET homeowner_signed_at=now() WHERE id=%L', qs))
      || ' / ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET contractor_signed_at=now() WHERE id=%L', qs));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nS10 LEGIT service_role UPDATE total_price=15250, fee_amount=762.50 on qs, SELECTED (the role docusign-webhook and its contract-price check run as): '
      || pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET total_price=15250, fee_amount=762.50 WHERE id=%L', qs)) || pg_temp.st(qs);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nS11 LEGIT ADMIN UPDATE total_price=15250 on qs, SELECTED (how a halted contract price is corrected by hand): '
      || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET total_price=15250 WHERE id=%L', qs), 'dustin@otterquote.com') || pg_temp.st(qs);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  BEGIN
    v := v || E'\nS12 OWNER selects q1 and k1 then tries total_price=1 on the newly selected q1: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', q1))
      || ' / ' || pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET total_price=1 WHERE id=%L', q1)) || pg_temp.st(q1);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  v := v || E'\nNOWRITE ' || format('rows of the seven tables before=%s after=%s unchanged=%s', before, pg_temp.snap(), before = pg_temp.snap());
  RETURN v;
END $s$;

SELECT pg_temp.fee_lock_scenario();
