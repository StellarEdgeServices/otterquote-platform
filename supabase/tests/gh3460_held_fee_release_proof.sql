-- gh-3460 proof (P18): release path for a held $5 on an 'unspecified' measurement order
-- (draft migration supabase/migrations_drafts/gh3460_held_fee_release.sql, on top of gh3229_partner_measurement_fee.sql).
-- ONE statement batch forced to roll back: every row is a fixture created inside the transaction (labelled gh3460), no real row is read or written,
-- the last statement is a deliberate RAISE EXCEPTION (same pattern as gh3229_partner_measurement_fee_proof.sql).
--   BEFORE : run this file alone (no migrations)                         -> rows DIFF
--   AFTER  : replace the two @@ lines with gh3229's body and gh3460's body (their BEGIN;/COMMIT; lines removed), same batch.
--   Local  : supabase/tests/gh3460_held_fee_release_local_run.sh  (before | after | rollback | mutant-*)
-- Every row is   key | got | want | OK or DIFF.   Sessions are simulated with SET LOCAL ROLE + request.jwt.claims; a failing statement reports 'ERR <sqlstate>'.
-- Cases
--   H1  an 'unspecified' order on a credited claim accrues nothing at insert (the hold)
--   H2  admin settles it to homeowner: ONE 500 accrued fee row for the right partner, role homeowner, audit line in admin_notes   (qualifying order accrues once)
--   H3  the same call again, and a direct homeowner->homeowner update: still one row (idempotent), already_settled = true
--   R1-R7 NON-QUALIFYING orders are refused, role stays 'unspecified', zero fee rows: excluded state (OK), home inspector, no credited referral, click outside the window,
--         is_test mismatch, partner never accepted v4, payment already carried a fee on another order
--   R8  p_require_fee => false records the homeowner role on a non-qualifying order with no fee (the role is settled, nothing owed)
--   G1-G6 admin only: a partner session and anon are refused; service_role works; bad role, unknown order, a settled order with a different role, contractor without id, homeowner with a contractor id are refused
--   C1  contractor settlement sets the role and contractor id and accrues nothing
--   T1  hand SQL UPDATE unspecified->homeowner on a qualifying order accrues once (the checks run in the trigger); on a non-qualifying order accrues nothing
--   T2  contractor->homeowner by direct UPDATE accrues nothing (the new arm is narrow); older homeowner order edits accrue nothing
CREATE TEMP TABLE _r(k text, got text, want text) ON COMMIT DROP;
-- @@MIGRATION_3229@@
-- @@MIGRATION@@

CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN EXECUTE p_sql INTO v; RETURN coalesce(v, '<NULL>');
EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE; END $f$;

CREATE FUNCTION pg_temp.as_sess(p_role text, p_uid uuid, p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    CASE WHEN p_uid IS NULL AND p_email IS NULL THEN json_build_object('role', p_role)::text
         ELSE json_build_object('sub', p_uid, 'role', p_role, 'email', p_email)::text END, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN EXECUTE p_sql INTO v; EXCEPTION WHEN OTHERS THEN v := 'ERR ' || SQLSTATE; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN coalesce(v, '<NULL>');
END $f$;

CREATE FUNCTION pg_temp.x(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE; END $f$;

CREATE FUNCTION pg_temp.chk(p_k text, p_got text, p_want text) RETURNS void LANGUAGE sql AS $f$ INSERT INTO _r VALUES (p_k, p_got, p_want) $f$;
CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT ('3460a000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;

CREATE FUNCTION pg_temp.mk_agent(n int, p_type text, p_test boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO auth.users(id, email) VALUES (pg_temp.u(200 + n), 'gh3460-' || n || '@example.invalid');
  INSERT INTO referral_agents(id, agent_type, first_name, last_name, email, unique_code, user_id, is_test, payments_blocked)
  VALUES (pg_temp.u(100 + n), p_type, 'Proof', 'P' || n, 'gh3460-' || n || '@example.invalid', 'GH3460' || n, pg_temp.u(200 + n), p_test, false);
  INSERT INTO public.gh3229_stub_v4(agent_id, accepted_at) VALUES (pg_temp.u(100 + n), now() - interval '300 days');
END $f$;

CREATE FUNCTION pg_temp.mk_claim(n int, p_claim_test boolean DEFAULT false, p_ref_test boolean DEFAULT false, p_age interval DEFAULT interval '1 day', p_state text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_ref uuid := gen_random_uuid(); v_claim uuid := gen_random_uuid();
BEGIN
  INSERT INTO referrals(id, referral_agent_id, status, created_at, is_test) VALUES (v_ref, pg_temp.u(100 + n), 'claim_submitted', now() - p_age, p_ref_test);
  INSERT INTO claims(id, user_id, is_test, referral_id, created_at, property_state) VALUES (v_claim, pg_temp.u(300 + n), p_claim_test, v_ref, now() - p_age, p_state);
  RETURN v_claim;
END $f$;

CREATE FUNCTION pg_temp.mk_order(p_claim uuid, p_role text DEFAULT 'unspecified', p_pi text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO hover_orders(id, claim_id, user_id, requested_by_role, homeowner_stripe_payment_intent_id, homeowner_charge_amount, created_at)
  VALUES (v_id, p_claim, pg_temp.u(399), p_role, coalesce(p_pi, 'pi_' || v_id::text), 1500, now());
  RETURN v_id;
END $f$;

-- settle as the admin; returns the function's jsonb->>'fee_cents'/'already_settled' or 'ERR <sqlstate>'
CREATE FUNCTION pg_temp.settle(p_order uuid, p_role text DEFAULT 'homeowner', p_contractor uuid DEFAULT NULL, p_require boolean DEFAULT true) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.as_sess('authenticated', pg_temp.u(299), 'dustin@otterquote.com',
    format($$ SELECT coalesce(r->>'fee_cents', 'none') || '/' || (r->>'already_settled') FROM (SELECT admin_settle_order_buyer_role(%L::uuid, %L, %L::uuid, 'proof', %L::boolean) r) x $$, p_order, p_role, p_contractor, p_require)) $f$;
CREATE FUNCTION pg_temp.fees(p_order uuid) RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE hover_order_id = %L $$, p_order)) $f$;
CREATE FUNCTION pg_temp.role_of(p_order uuid) RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.q(format($$ SELECT requested_by_role FROM hover_orders WHERE id = %L $$, p_order)) $f$;

SELECT pg_temp.mk_agent(1, 're_agent');
SELECT pg_temp.mk_agent(2, 'home_inspector');
SELECT pg_temp.mk_agent(3, 'other');           -- test agent
SELECT pg_temp.mk_agent(4, 'other');           -- never accepted v4
SELECT pg_temp.mk_agent(5, 'other');           -- click outside the window
SELECT pg_temp.mk_agent(6, 'other');           -- payment already carried a fee
DELETE FROM public.gh3229_stub_v4 WHERE agent_id = pg_temp.u(104);
INSERT INTO auth.users(id, email) VALUES (pg_temp.u(299), 'gh3460-admin@example.invalid');
INSERT INTO platform_settings(key, value) VALUES ('partner_measurement_fee_cents', to_jsonb(500)), ('partner_payout_minimum_cents', to_jsonb(2500)) ON CONFLICT (key) DO NOTHING;
CREATE TEMP TABLE o(k text PRIMARY KEY, id uuid) ON COMMIT DROP;
CREATE TEMP TABLE c(k text PRIMARY KEY, id uuid) ON COMMIT DROP;
INSERT INTO contractors(id, user_id) VALUES (pg_temp.u(500), pg_temp.u(501));

-- H1 the hold ------------------------------------------------------------------------------------------------------------------------------
INSERT INTO c VALUES ('q', pg_temp.mk_claim(1));
INSERT INTO o SELECT 'q', pg_temp.mk_order((SELECT id FROM c WHERE k='q'));
SELECT pg_temp.chk('H1 unspecified order on a credited claim: fee rows at insert', pg_temp.fees((SELECT id FROM o WHERE k='q')), '0');
-- H2 qualifying order accrues once through the admin function
SELECT pg_temp.chk('H2 settle homeowner (qualifying): fee_cents / already_settled', pg_temp.settle((SELECT id FROM o WHERE k='q')), '500/false');
SELECT pg_temp.chk('H2 one fee row, accrued, 500, for partner 1', pg_temp.q(format(
  $$ SELECT count(*) || '/' || max(amount_cents) || '/' || max(status) || '/' || bool_and(referral_agent_id = %L) FROM partner_fee_events WHERE hover_order_id = %L $$, pg_temp.u(101), (SELECT id FROM o WHERE k='q'))), '1/500/accrued/true');
SELECT pg_temp.chk('H2 role homeowner, audit line in admin_notes', pg_temp.q(format(
  $$ SELECT requested_by_role || '/' || (admin_notes LIKE '%%unspecified -> homeowner by dustin@otterquote.com%%(gh-3460): proof%%') FROM hover_orders WHERE id = %L $$, (SELECT id FROM o WHERE k='q'))), 'homeowner/true');
-- H3 idempotent
SELECT pg_temp.chk('H3 same call again: already_settled, same fee', pg_temp.settle((SELECT id FROM o WHERE k='q')), '500/true');
SELECT pg_temp.x(format($$ UPDATE hover_orders SET requested_by_role = 'homeowner', admin_notes = admin_notes WHERE id = %L $$, (SELECT id FROM o WHERE k='q')));
SELECT pg_temp.chk('H3 direct homeowner->homeowner update: still one row for partner 1 / this order', pg_temp.q(format(
  $$ SELECT (SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L) || '/' || (SELECT count(*) FROM partner_fee_events WHERE hover_order_id = %L) $$, pg_temp.u(101), (SELECT id FROM o WHERE k='q'))), '1/1');

-- R1-R7 non-qualifying orders are refused ---------------------------------------------------------------------------------------------------
INSERT INTO c VALUES ('r1', pg_temp.mk_claim(1, false, false, interval '1 day', 'OK'));
INSERT INTO o SELECT 'r1', pg_temp.mk_order((SELECT id FROM c WHERE k='r1'));
SELECT pg_temp.chk('R1 excluded state OK: refused', pg_temp.settle((SELECT id FROM o WHERE k='r1')), 'ERR 22023');
SELECT pg_temp.chk('R1 role still unspecified, 0 fee rows', pg_temp.role_of((SELECT id FROM o WHERE k='r1')) || '/' || pg_temp.fees((SELECT id FROM o WHERE k='r1')), 'unspecified/0');
INSERT INTO c VALUES ('r2', pg_temp.mk_claim(2));
INSERT INTO o SELECT 'r2', pg_temp.mk_order((SELECT id FROM c WHERE k='r2'));
SELECT pg_temp.chk('R2 home inspector partner: refused, still unspecified, 0 fees', pg_temp.settle((SELECT id FROM o WHERE k='r2')) || '/' || pg_temp.role_of((SELECT id FROM o WHERE k='r2')) || '/' || pg_temp.fees((SELECT id FROM o WHERE k='r2')), 'ERR 22023/unspecified/0');
INSERT INTO claims(id, user_id, is_test) VALUES ('3460c000-0000-4000-8000-000000000001', pg_temp.u(398), false);
INSERT INTO o SELECT 'r3', pg_temp.mk_order('3460c000-0000-4000-8000-000000000001');
SELECT pg_temp.chk('R3 no credited referral: refused, still unspecified, 0 fees', pg_temp.settle((SELECT id FROM o WHERE k='r3')) || '/' || pg_temp.role_of((SELECT id FROM o WHERE k='r3')) || '/' || pg_temp.fees((SELECT id FROM o WHERE k='r3')), 'ERR 22023/unspecified/0');
INSERT INTO c VALUES ('r4', pg_temp.mk_claim(5, false, false, public.referral_attribution_window() + interval '5 days'));
INSERT INTO o SELECT 'r4', pg_temp.mk_order((SELECT id FROM c WHERE k='r4'));
SELECT pg_temp.chk('R4 click outside the window: refused, still unspecified, 0 fees', pg_temp.settle((SELECT id FROM o WHERE k='r4')) || '/' || pg_temp.role_of((SELECT id FROM o WHERE k='r4')) || '/' || pg_temp.fees((SELECT id FROM o WHERE k='r4')), 'ERR 22023/unspecified/0');
INSERT INTO c VALUES ('r5', pg_temp.mk_claim(3, true, false));
INSERT INTO o SELECT 'r5', pg_temp.mk_order((SELECT id FROM c WHERE k='r5'));
SELECT pg_temp.chk('R5 is_test mismatch: refused, still unspecified, 0 fees', pg_temp.settle((SELECT id FROM o WHERE k='r5')) || '/' || pg_temp.role_of((SELECT id FROM o WHERE k='r5')) || '/' || pg_temp.fees((SELECT id FROM o WHERE k='r5')), 'ERR 22023/unspecified/0');
INSERT INTO c VALUES ('r6', pg_temp.mk_claim(4));
INSERT INTO o SELECT 'r6', pg_temp.mk_order((SELECT id FROM c WHERE k='r6'));
SELECT pg_temp.chk('R6 partner never accepted v4: refused, still unspecified, 0 fees', pg_temp.settle((SELECT id FROM o WHERE k='r6')) || '/' || pg_temp.role_of((SELECT id FROM o WHERE k='r6')) || '/' || pg_temp.fees((SELECT id FROM o WHERE k='r6')), 'ERR 22023/unspecified/0');
-- R7 one fee per payment: a homeowner order already took the fee for pi_gh3460_dup; a held order with the same PaymentIntent cannot take a second
INSERT INTO c VALUES ('r7', pg_temp.mk_claim(6));
INSERT INTO o SELECT 'r7a', pg_temp.mk_order((SELECT id FROM c WHERE k='r7'), 'homeowner', 'pi_gh3460_dup');
INSERT INTO o SELECT 'r7b', pg_temp.mk_order((SELECT id FROM c WHERE k='r7'), 'unspecified', 'pi_gh3460_dup');
SELECT pg_temp.chk('R7 first order of the payment accrued', pg_temp.fees((SELECT id FROM o WHERE k='r7a')), '1');
SELECT pg_temp.chk('R7 second order, same PaymentIntent: refused, still unspecified, partner 6 has 1 fee', pg_temp.settle((SELECT id FROM o WHERE k='r7b')) || '/' || pg_temp.role_of((SELECT id FROM o WHERE k='r7b')) || '/' ||
  pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(106))), 'ERR 22023/unspecified/1');
-- R8 role only
SELECT pg_temp.chk('R8 p_require_fee false on the excluded-state order: role recorded, no fee', pg_temp.settle((SELECT id FROM o WHERE k='r1'), 'homeowner', NULL, false) || '/' || pg_temp.role_of((SELECT id FROM o WHERE k='r1')) || '/' || pg_temp.fees((SELECT id FROM o WHERE k='r1')), 'none/false/homeowner/0');

-- G admin only and argument checks ------------------------------------------------------------------------------------------------------------
INSERT INTO c VALUES ('g', pg_temp.mk_claim(1));
INSERT INTO o SELECT 'g1', pg_temp.mk_order((SELECT id FROM c WHERE k='g'));
SELECT pg_temp.chk('G1 partner session refused (42501), role unchanged', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3460-1@example.invalid',
  format($$ SELECT admin_settle_order_buyer_role(%L::uuid, 'homeowner')::text $$, (SELECT id FROM o WHERE k='g1'))) || '/' || pg_temp.role_of((SELECT id FROM o WHERE k='g1')), 'ERR 42501/unspecified');
SELECT pg_temp.chk('G2 anon refused', pg_temp.as_sess('anon', NULL, NULL, format($$ SELECT admin_settle_order_buyer_role(%L::uuid, 'homeowner')::text $$, (SELECT id FROM o WHERE k='g1'))), 'ERR 42501');
SELECT pg_temp.chk('G3 bad role refused', pg_temp.as_sess('authenticated', pg_temp.u(299), 'dustin@otterquote.com', format($$ SELECT admin_settle_order_buyer_role(%L::uuid, 'admin')::text $$, (SELECT id FROM o WHERE k='g1'))), 'ERR 22023');
SELECT pg_temp.chk('G3 unknown order refused', pg_temp.as_sess('authenticated', pg_temp.u(299), 'dustin@otterquote.com', $$ SELECT admin_settle_order_buyer_role('3460c000-0000-4000-8000-0000000000ff'::uuid, 'homeowner')::text $$), 'ERR P0002');
SELECT pg_temp.chk('G4 contractor without contractor id refused / homeowner with a contractor id refused', pg_temp.settle((SELECT id FROM o WHERE k='g1'), 'contractor') || '/' || pg_temp.settle((SELECT id FROM o WHERE k='g1'), 'homeowner', pg_temp.u(500)), 'ERR 22023/ERR 22023');
SELECT pg_temp.chk('G5 service_role may settle', pg_temp.as_sess('service_role', NULL, NULL, format($$ SELECT (r->>'fee_cents') FROM (SELECT admin_settle_order_buyer_role(%L::uuid, 'homeowner') r) x $$, (SELECT id FROM o WHERE k='g1'))), '500');
SELECT pg_temp.chk('G6 a settled homeowner order cannot be re-settled to contractor (55000)', pg_temp.settle((SELECT id FROM o WHERE k='g1'), 'contractor', pg_temp.u(500)), 'ERR 55000');
SELECT pg_temp.chk('G7 anon has no EXECUTE', pg_temp.q($$ SELECT has_function_privilege('anon', 'public.admin_settle_order_buyer_role(uuid,text,uuid,text,boolean)', 'EXECUTE')::text $$), 'false');

-- C contractor ------------------------------------------------------------------------------------------------------------------------------
INSERT INTO c VALUES ('c', pg_temp.mk_claim(1));
INSERT INTO o SELECT 'c1', pg_temp.mk_order((SELECT id FROM c WHERE k='c'));
SELECT pg_temp.chk('C1 contractor settlement: role, contractor id, no fee', pg_temp.settle((SELECT id FROM o WHERE k='c1'), 'contractor', pg_temp.u(500)) || '/' || pg_temp.q(format(
  $$ SELECT requested_by_role || '/' || (requested_by_contractor_id = %L) FROM hover_orders WHERE id = %L $$, pg_temp.u(500), (SELECT id FROM o WHERE k='c1'))) || '/' || pg_temp.fees((SELECT id FROM o WHERE k='c1')), 'none/false/contractor/true/0');

-- T hand SQL --------------------------------------------------------------------------------------------------------------------------------
INSERT INTO c VALUES ('t', pg_temp.mk_claim(1));
INSERT INTO o SELECT 't1', pg_temp.mk_order((SELECT id FROM c WHERE k='t'));
SELECT pg_temp.x(format($$ UPDATE hover_orders SET requested_by_role = 'homeowner' WHERE id = %L $$, (SELECT id FROM o WHERE k='t1')));
SELECT pg_temp.chk('T1 hand UPDATE unspecified->homeowner on a qualifying order: one fee', pg_temp.fees((SELECT id FROM o WHERE k='t1')), '1');
INSERT INTO c VALUES ('t2', pg_temp.mk_claim(1, false, false, interval '1 day', 'MS'));
INSERT INTO o SELECT 't2', pg_temp.mk_order((SELECT id FROM c WHERE k='t2'));
SELECT pg_temp.x(format($$ UPDATE hover_orders SET requested_by_role = 'homeowner' WHERE id = %L $$, (SELECT id FROM o WHERE k='t2')));
SELECT pg_temp.chk('T1 hand UPDATE on a non-qualifying order (MS): no fee', pg_temp.fees((SELECT id FROM o WHERE k='t2')), '0');
INSERT INTO c VALUES ('t3', pg_temp.mk_claim(1));
INSERT INTO o SELECT 't3', pg_temp.mk_order((SELECT id FROM c WHERE k='t3'), 'contractor');
SELECT pg_temp.x(format($$ UPDATE hover_orders SET requested_by_role = 'homeowner' WHERE id = %L $$, (SELECT id FROM o WHERE k='t3')));
SELECT pg_temp.chk('T2 contractor->homeowner by hand: no fee (arm is unspecified-only)', pg_temp.fees((SELECT id FROM o WHERE k='t3')), '0');
INSERT INTO hover_orders(id, claim_id, user_id, requested_by_role, homeowner_charge_amount) VALUES ('3460f000-0000-4000-8000-000000000001', (SELECT id FROM c WHERE k='t3'), pg_temp.u(399), NULL, 1500);
SELECT pg_temp.x($$ UPDATE hover_orders SET requested_by_role = 'homeowner', homeowner_stripe_payment_intent_id = 'pi_gh3460_late' WHERE id = '3460f000-0000-4000-8000-000000000001' $$);
SELECT pg_temp.chk('T2 NULL-role older order edited to homeowner: no fee', pg_temp.fees('3460f000-0000-4000-8000-000000000001'), '0');

DO $f$
DECLARE s text; n_ok int; n_diff int;
BEGIN
  SELECT string_agg(rpad(k, 100) || ' | got ' || got || ' | want ' || want || ' | ' || CASE WHEN got = want THEN 'OK' ELSE 'DIFF' END, E'\n' ORDER BY k),
         count(*) FILTER (WHERE got = want), count(*) FILTER (WHERE got <> want)
    INTO s, n_ok, n_diff FROM _r;
  RAISE EXCEPTION E'GH3460 PROOF (forced rollback)\n%\nTALLY: % OK, % DIFF', s, n_ok, n_diff USING ERRCODE = 'P0U01';
END $f$;
