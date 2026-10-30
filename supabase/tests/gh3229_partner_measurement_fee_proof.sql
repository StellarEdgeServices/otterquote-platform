-- gh-3229 proof (P18): $5 measurement referral fee, monthly batch ($25 minimum), partner dashboard stats
-- (draft migration supabase/migrations_drafts/gh3229_partner_measurement_fee.sql).
-- ONE statement batch that is forced to roll back: every row is a fixture created inside the transaction (auth users, partners, referrals, claims,
-- hover orders, all labelled gh3229), no real row is read or written, and the last statement is a deliberate RAISE EXCEPTION, so nothing commits
-- (same pattern as gh2997_inherit_is_test_proof.sql / gh3217_mask_referral_homeowner_proof.sql).
--   BEFORE the fix : run this file alone.                                  -> every row DIFF (nothing exists yet)
--   AFTER the fix  : replace the @@MIGRATION@@ line with the migration body (its own BEGIN;/COMMIT; lines removed), same batch.
--   Local          : supabase/tests/gh3229_partner_measurement_fee_local_run.sh  (before | after | rollback | mutant-*)
-- Every row is   key | got | want | OK or DIFF   and the exception message ends with the OK/DIFF tally.
-- Sessions are simulated with SET LOCAL ROLE + request.jwt.claims; a failing statement reports 'ERR <sqlstate>'.
-- Fixtures: partners A (re_agent), B (insurance_agent), I (home_inspector), K (recruited by A), P / R (6 orders each = $30), Q (4 orders = $20),
--   W (payments_blocked, 6 orders), T (is_test), M (real partner, test claim), X (click 100 days old). Orders are homeowner-paid unless a case says otherwise.
-- Cases (the key prefix is the case id):
--   F1-F4 credited paid order -> one 500 row; setting 700 -> the next row is 700; no credited partner -> no row; a duplicate order update -> no second row
--   F5-F9 inspector, click outside window, is_test mismatch, contractor-role order, order without a Stripe id -> no row; all-test chain -> one is_test row
--   S1-S8 partner B cannot read A's rows; no client writes; anon nothing; privileges
--   B1-B9 $30 batches once, a rerun creates nothing; $20 no batch; payments_blocked no batch; non-admin refused
--   P1-P3 mark paid flips the events (service role only), once; R1 a rejected batch payout releases its events and the next run re-batches them
--   V1-V2 the job-completion rebate (rebate_paid_at) does NOT void or change a fee event, accrued or paid (CEO ruling, #3236)
--   F10   a customer (refer-a-friend) agent accrues the $5 like any partner
--   D10-D11 stats are is_test-matching: a test partner sees only test rows, a real partner only real rows
--   D1-D9 dashboard stats: caller only, is_test-matching, both fees, next payout, recruit earnings for A but not the recruit's own fees

CREATE TEMP TABLE _r(k text, got text, want text) ON COMMIT DROP;
-- (migration body is spliced here for the AFTER run; the BEFORE run has nothing here)
-- @@MIGRATION@@

-- run a scalar query; 'ERR <sqlstate>' if it fails
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN coalesce(v, '<NULL>');
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERR ' || SQLSTATE;
END $f$;

-- run a scalar query as a simulated session
CREATE FUNCTION pg_temp.as_sess(p_role text, p_uid uuid, p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    CASE WHEN p_uid IS NULL AND p_email IS NULL THEN json_build_object('role', p_role)::text
         ELSE json_build_object('sub', p_uid, 'role', p_role, 'email', p_email)::text END, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    v := 'ERR ' || SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN coalesce(v, '<NULL>');
END $f$;

CREATE FUNCTION pg_temp.chk(p_k text, p_got text, p_want text) RETURNS void LANGUAGE sql AS
  $f$ INSERT INTO _r VALUES (p_k, p_got, p_want) $f$;

CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $f$ SELECT ('3229a000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;

-- partner n: agent id u(100+n), user id u(200+n)
CREATE FUNCTION pg_temp.mk_agent(n int, p_type text, p_test boolean DEFAULT false, p_blocked boolean DEFAULT false, p_recruiter int DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO auth.users(id, email) VALUES (pg_temp.u(200 + n), 'gh3229-' || n || '@example.invalid');
  INSERT INTO referral_agents(id, agent_type, first_name, last_name, email, unique_code, user_id, is_test, payments_blocked, recruited_by_id, recruited_at)
  VALUES (pg_temp.u(100 + n), p_type, 'Proof', 'P' || n, 'gh3229-' || n || '@example.invalid', 'GH3229' || n, pg_temp.u(200 + n), p_test, p_blocked,
          CASE WHEN p_recruiter IS NULL THEN NULL ELSE pg_temp.u(100 + p_recruiter) END,
          CASE WHEN p_recruiter IS NULL THEN NULL ELSE now() - interval '400 days' END);
END $f$;

-- a claim credited to partner n through a referral clicked p_age before the claim; returns the claim id
CREATE FUNCTION pg_temp.mk_claim(n int, p_claim_test boolean DEFAULT false, p_ref_test boolean DEFAULT false, p_age interval DEFAULT interval '1 day') RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_ref uuid := gen_random_uuid(); v_claim uuid := gen_random_uuid();
BEGIN
  INSERT INTO referrals(id, referral_agent_id, status, created_at, is_test) VALUES (v_ref, pg_temp.u(100 + n), 'claim_submitted', now() - p_age, p_ref_test);
  INSERT INTO claims(id, user_id, is_test, referral_id, created_at) VALUES (v_claim, pg_temp.u(300 + n), p_claim_test, v_ref, now());
  RETURN v_claim;
END $f$;

CREATE FUNCTION pg_temp.mk_order(p_claim uuid, p_role text DEFAULT 'homeowner', p_pi text DEFAULT NULL, p_amount int DEFAULT 1500) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO hover_orders(id, claim_id, user_id, requested_by_role, homeowner_stripe_payment_intent_id, homeowner_charge_amount)
  VALUES (v_id, p_claim, pg_temp.u(399), p_role, coalesce(p_pi, 'pi_' || v_id::text), p_amount);
  RETURN v_id;
END $f$;

-- fixtures ------------------------------------------------------------------------------------------------------------------------------------
SELECT pg_temp.mk_agent(1, 're_agent');
SELECT pg_temp.mk_agent(2, 'insurance_agent');
SELECT pg_temp.mk_agent(3, 'home_inspector');
SELECT pg_temp.mk_agent(4, 'other', false, false, 1);          -- K, recruited by A
SELECT pg_temp.mk_agent(5, 'other');                           -- P
SELECT pg_temp.mk_agent(6, 'other');                           -- Q
SELECT pg_temp.mk_agent(7, 'other');                           -- R
SELECT pg_temp.mk_agent(8, 'other', false, true);              -- W, payments_blocked
SELECT pg_temp.mk_agent(9, 'other', true);                     -- T, is_test
SELECT pg_temp.mk_agent(10, 'other');                          -- M
SELECT pg_temp.mk_agent(11, 'other');                          -- X
SELECT pg_temp.mk_agent(12, 'customer');                       -- C, refer-a-friend customer
INSERT INTO auth.users(id, email) VALUES (pg_temp.u(299), 'gh3229-nonpartner@example.invalid');
INSERT INTO platform_settings(key, value) VALUES ('partner_measurement_fee_cents', to_jsonb(500)), ('partner_payout_minimum_cents', to_jsonb(2500))
  ON CONFLICT (key) DO NOTHING;   -- the migration seeds these; harmless in the AFTER run, supplies them in the BEFORE run

CREATE TEMP TABLE o(k text PRIMARY KEY, id uuid) ON COMMIT DROP;
CREATE TEMP TABLE c(k text PRIMARY KEY, id uuid) ON COMMIT DROP;

-- F1 credited paid order
INSERT INTO c VALUES ('a1', pg_temp.mk_claim(1));
INSERT INTO o SELECT 'a1', pg_temp.mk_order((SELECT id FROM c WHERE k = 'a1'));
SELECT pg_temp.chk('F1 credited paid order: rows / amount / status / is_test', pg_temp.q(format(
  $$ SELECT count(*) || '/' || max(amount_cents) || '/' || max(status) || '/' || bool_or(is_test) FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'a1'))), '1/500/accrued/false');
-- F2 setting 700 -> the next row is 700 (read at insert time); the first row keeps 500
UPDATE platform_settings SET value = to_jsonb(700) WHERE key = 'partner_measurement_fee_cents';
INSERT INTO c VALUES ('a2', pg_temp.mk_claim(1));
INSERT INTO o SELECT 'a2', pg_temp.mk_order((SELECT id FROM c WHERE k = 'a2'));
UPDATE platform_settings SET value = to_jsonb(500) WHERE key = 'partner_measurement_fee_cents';
SELECT pg_temp.chk('F2 setting 700: next row amount', pg_temp.q(format($$ SELECT amount_cents FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'a2'))), '700');
SELECT pg_temp.chk('F2 first row still 500', pg_temp.q(format($$ SELECT amount_cents FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'a1'))), '500');
-- F3 no credited partner
INSERT INTO claims(id, user_id, is_test) VALUES ('3229c000-0000-4000-8000-000000000001', pg_temp.u(398), false);
INSERT INTO o SELECT 'none', pg_temp.mk_order('3229c000-0000-4000-8000-000000000001');
SELECT pg_temp.chk('F3 claim with no referral: rows', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'none'))), '0');
-- F4 duplicate order update: no second row
UPDATE hover_orders SET stripe_payment_id = 'ch_dup', homeowner_charge_amount = 1500, requested_by_role = 'homeowner' WHERE id = (SELECT id FROM o WHERE k = 'a1');
UPDATE hover_orders SET claim_id = claim_id WHERE id = (SELECT id FROM o WHERE k = 'a1');
SELECT pg_temp.chk('F4 duplicate update: rows for the order / for A', pg_temp.q(format(
  $$ SELECT (SELECT count(*) FROM partner_fee_events WHERE hover_order_id = %L) || '/' || (SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L) $$,
  (SELECT id FROM o WHERE k = 'a1'), pg_temp.u(101))), '1/2');
-- F5 inspector (D-333)
INSERT INTO c VALUES ('i', pg_temp.mk_claim(3));
INSERT INTO o SELECT 'i', pg_temp.mk_order((SELECT id FROM c WHERE k = 'i'));
SELECT pg_temp.chk('F5 home inspector: rows', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(103))), '0');
-- F6 click outside the window (100 days before the claim; the window is 30 or 90 days)
INSERT INTO c VALUES ('x', pg_temp.mk_claim(11, false, false, interval '100 days'));
INSERT INTO o SELECT 'x', pg_temp.mk_order((SELECT id FROM c WHERE k = 'x'));
SELECT pg_temp.chk('F6 click outside window: rows', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(111))), '0');
-- F7 is_test mismatch (test claim, real referral and agent)
INSERT INTO c VALUES ('m', pg_temp.mk_claim(10, true, false));
INSERT INTO o SELECT 'm', pg_temp.mk_order((SELECT id FROM c WHERE k = 'm'));
SELECT pg_temp.chk('F7 is_test mismatch: rows', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(110))), '0');
-- F8 contractor-role order, and a homeowner order with no Stripe payment id
INSERT INTO c VALUES ('p0', pg_temp.mk_claim(5));
INSERT INTO o SELECT 'p0c', pg_temp.mk_order((SELECT id FROM c WHERE k = 'p0'), 'contractor');
INSERT INTO hover_orders(id, claim_id, user_id, requested_by_role, homeowner_charge_amount) VALUES (gen_random_uuid(), (SELECT id FROM c WHERE k = 'p0'), pg_temp.u(399), 'homeowner', 1500);
SELECT pg_temp.chk('F8 contractor order / homeowner order without a Stripe id: rows for P', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(105))), '0');
-- F9 all-test chain accrues an is_test row
INSERT INTO c VALUES ('t', pg_temp.mk_claim(9, true, true));
INSERT INTO o SELECT 't', pg_temp.mk_order((SELECT id FROM c WHERE k = 't'));
SELECT pg_temp.chk('F9 all-test chain: rows / is_test / amount', pg_temp.q(format($$ SELECT count(*) || '/' || bool_and(is_test) || '/' || max(amount_cents) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(109))), '1/true/500');

-- F10 customer agent accrues
INSERT INTO c VALUES ('cu', pg_temp.mk_claim(12));
INSERT INTO o SELECT 'cu', pg_temp.mk_order((SELECT id FROM c WHERE k = 'cu'));
SELECT pg_temp.chk('F10 customer agent: rows / amount', pg_temp.q(format($$ SELECT count(*) || '/' || max(amount_cents) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(112))), '1/500');

-- B's own order, K's order (K is recruited by A)
INSERT INTO c VALUES ('b', pg_temp.mk_claim(2));
INSERT INTO o SELECT 'b', pg_temp.mk_order((SELECT id FROM c WHERE k = 'b'));
INSERT INTO c VALUES ('k', pg_temp.mk_claim(4));
INSERT INTO o SELECT 'k', pg_temp.mk_order((SELECT id FROM c WHERE k = 'k'));

-- security -------------------------------------------------------------------------------------------------------------------------------------
SELECT pg_temp.chk('S1 B reads A''s rows', pg_temp.as_sess('authenticated', pg_temp.u(202), 'gh3229-2@example.invalid',
  format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(101))), '0');
SELECT pg_temp.chk('S2 B reads own rows', pg_temp.as_sess('authenticated', pg_temp.u(202), 'gh3229-2@example.invalid', $$ SELECT count(*) FROM partner_fee_events $$), '1');
SELECT pg_temp.chk('S3 A reads own rows', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-1@example.invalid', $$ SELECT count(*) FROM partner_fee_events $$), '2');
SELECT pg_temp.chk('S4 admin reads all rows (fixture count)', pg_temp.as_sess('authenticated', pg_temp.u(299), 'dustin@otterquote.com',
  $$ SELECT count(*) FROM partner_fee_events WHERE claim_id IS NOT NULL $$), pg_temp.q($$ SELECT count(*) FROM partner_fee_events $$));
SELECT pg_temp.chk('S5 partner INSERT refused', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-1@example.invalid',
  format($$ WITH i AS (INSERT INTO partner_fee_events(referral_agent_id, amount_cents) VALUES (%L, 500) RETURNING 1) SELECT count(*) FROM i $$, pg_temp.u(101))), 'ERR 42501');
SELECT pg_temp.chk('S6 partner UPDATE refused', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-1@example.invalid',
  $$ WITH u AS (UPDATE partner_fee_events SET amount_cents = 99999 RETURNING 1) SELECT count(*) FROM u $$), 'ERR 42501');
SELECT pg_temp.chk('S7 anon SELECT refused', pg_temp.as_sess('anon', NULL, NULL, $$ SELECT count(*) FROM partner_fee_events $$), 'ERR 42501');
SELECT pg_temp.chk('S8 table privileges authenticated S,I,U,D / anon S (want true,false,false,false / false)', pg_temp.q(
  $$ SELECT has_table_privilege('authenticated','public.partner_fee_events','SELECT') || ',' || has_table_privilege('authenticated','public.partner_fee_events','INSERT')
     || ',' || has_table_privilege('authenticated','public.partner_fee_events','UPDATE') || ',' || has_table_privilege('authenticated','public.partner_fee_events','DELETE')
     || ' / ' || has_table_privilege('anon','public.partner_fee_events','SELECT') $$), 'true,false,false,false / false');

-- orders for the batch cases: P 6, R 6 ($30 each), Q 4 ($20), W 6 (blocked)
INSERT INTO o SELECT 'p' || g, pg_temp.mk_order(pg_temp.mk_claim(5)) FROM generate_series(1, 6) g;
INSERT INTO o SELECT 'r' || g, pg_temp.mk_order(pg_temp.mk_claim(7)) FROM generate_series(1, 6) g;
INSERT INTO o SELECT 'q' || g, pg_temp.mk_order(pg_temp.mk_claim(6)) FROM generate_series(1, 4) g;
INSERT INTO o SELECT 'w' || g, pg_temp.mk_order(pg_temp.mk_claim(8)) FROM generate_series(1, 6) g;

-- partner A: a pending and a paid $200 fee, and a recruit bonus on K's job
INSERT INTO payout_approvals(referral_id, payout_type, partner_id, partner_name, amount, status, is_test) VALUES
  (NULL, 'commission_referral', pg_temp.u(101), 'Proof P1', 200, 'pending_approval', false),
  (NULL, 'commission_referral', pg_temp.u(101), 'Proof P1', 200, 'paid', false),
  (NULL, 'commission_referral', pg_temp.u(101), 'Proof P1', 200, 'rejected', false);
UPDATE referrals SET recruit_commission_amount = 50, status = 'job_completed' WHERE id = (SELECT referral_id FROM claims WHERE id = (SELECT id FROM c WHERE k = 'k'));

-- cross-flag fixtures for D10/D11 (inserted directly): a TEST fee event + test referral under real partner A, a REAL fee event under test partner T
INSERT INTO referrals(id, referral_agent_id, status, created_at, is_test) VALUES
  ('3229e000-0000-4000-8000-000000000001', pg_temp.u(101), 'clicked', now(), true),
  ('3229e000-0000-4000-8000-000000000002', pg_temp.u(109), 'clicked', now(), false);
INSERT INTO partner_fee_events(referral_agent_id, amount_cents, status, is_test) SELECT pg_temp.u(101), 500, 'accrued', true WHERE to_regclass('public.partner_fee_events') IS NOT NULL;
INSERT INTO partner_fee_events(referral_agent_id, amount_cents, status, is_test) SELECT pg_temp.u(109), 500, 'accrued', false WHERE to_regclass('public.partner_fee_events') IS NOT NULL;

-- dashboard stats, before any batch ---------------------------------------------------------------------------------------------------------------
SELECT pg_temp.chk('D1 A stats: clicks/signed up/measurements/jobs', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-1@example.invalid',
  $$ SELECT clicks || '/' || homeowners_signed_up || '/' || measurements_purchased || '/' || jobs_completed FROM get_partner_dashboard_stats() $$), '2/2/2/0');
SELECT pg_temp.chk('D2 A stats: $200 accrued/paid, $5 accrued/paid, earnings accrued/paid (cents)', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-1@example.invalid',
  $$ SELECT referral_fees_accrued_cents || '/' || referral_fees_paid_cents || '/' || measurement_fees_accrued_cents || '/' || measurement_fees_paid_cents || '/' || earnings_accrued_cents || '/' || earnings_paid_cents FROM get_partner_dashboard_stats() $$),
  '20000/20000/1200/0/21200/20000');
SELECT pg_temp.chk('D3 A stats: next payout 0 under the minimum, minimum 2500, accrued 1200', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-1@example.invalid',
  $$ SELECT next_payout_cents || '/' || payout_minimum_cents || '/' || accrued_toward_minimum_cents FROM get_partner_dashboard_stats() $$), '0/2500/1200');
SELECT pg_temp.chk('D4 P stats: next payout = $30 (accrued, at the minimum, not blocked)', pg_temp.as_sess('authenticated', pg_temp.u(205), 'gh3229-5@example.invalid',
  $$ SELECT next_payout_cents || '/' || accrued_toward_minimum_cents FROM get_partner_dashboard_stats() $$), '3000/3000');
SELECT pg_temp.chk('D5 W stats: payments_blocked -> next payout 0', pg_temp.as_sess('authenticated', pg_temp.u(208), 'gh3229-8@example.invalid',
  $$ SELECT next_payout_cents || '/' || accrued_toward_minimum_cents FROM get_partner_dashboard_stats() $$), '0/3000');
SELECT pg_temp.chk('D6 T stats (test partner) sees its own test rows: measurements / $5 accrued / clicks', pg_temp.as_sess('authenticated', pg_temp.u(209), 'gh3229-9@example.invalid',
  $$ SELECT measurements_purchased || '/' || measurement_fees_accrued_cents || '/' || clicks FROM get_partner_dashboard_stats() $$), '1/500/1');
SELECT pg_temp.chk('D10 ... and not T''s real-flagged event or referral (test caller sees only test rows)', pg_temp.as_sess('authenticated', pg_temp.u(209), 'gh3229-9@example.invalid',
  $$ SELECT accrued_toward_minimum_cents || '/' || homeowners_signed_up FROM get_partner_dashboard_stats() $$), '500/1');
SELECT pg_temp.chk('D11 real partner A does not see its test-flagged event or referral (D1-D3 totals unchanged): $5 accrued / clicks', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-1@example.invalid',
  $$ SELECT measurement_fees_accrued_cents || '/' || clicks FROM get_partner_dashboard_stats() $$), '1200/2');
SELECT pg_temp.chk('D7 A recruit earnings: total cents and K''s entry (A sees the bonus ...)', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-1@example.invalid',
  format($$ SELECT recruit_earnings_cents || '/' || (SELECT e->>'earnings_cents' FROM jsonb_array_elements(recruits) e WHERE e->>'recruit_id' = %L) FROM get_partner_dashboard_stats() $$, pg_temp.u(104))), '5000/5000');
SELECT pg_temp.chk('D8 ... but nothing of K''s own fees: A''s $5 count excludes K''s order, recruits[] holds only recruit_id and earnings_cents', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-1@example.invalid',
  $$ SELECT measurements_purchased || '/' || (SELECT string_agg(DISTINCT k, ',' ORDER BY k) FROM jsonb_array_elements(recruits) e, jsonb_object_keys(e) k) FROM get_partner_dashboard_stats() $$), '2/earnings_cents,recruit_id');
SELECT pg_temp.chk('D9 K sees own fee, no recruit earnings; B sees no recruits; non-partner and anon get nothing',
  pg_temp.as_sess('authenticated', pg_temp.u(204), 'gh3229-4@example.invalid', $$ SELECT measurements_purchased || '/' || recruit_earnings_cents FROM get_partner_dashboard_stats() $$) || ' ; ' ||
  pg_temp.as_sess('authenticated', pg_temp.u(202), 'gh3229-2@example.invalid', $$ SELECT recruit_earnings_cents || '/' || recruits::text FROM get_partner_dashboard_stats() $$) || ' ; ' ||
  pg_temp.as_sess('authenticated', pg_temp.u(299), 'gh3229-nonpartner@example.invalid', $$ SELECT count(*) FROM get_partner_dashboard_stats() $$) || ' ; ' ||
  pg_temp.as_sess('anon', NULL, NULL, $$ SELECT count(*) FROM get_partner_dashboard_stats() $$),
  '1/0 ; 0/[] ; 0 ; ERR 42501');

-- monthly batch ----------------------------------------------------------------------------------------------------------------------------------
SELECT pg_temp.chk('B1 non-admin refused', pg_temp.as_sess('authenticated', pg_temp.u(202), 'gh3229-2@example.invalid', $$ SELECT create_monthly_fee_batch(current_date)::text $$), 'ERR 42501');
SELECT pg_temp.chk('B2 anon refused', pg_temp.as_sess('anon', NULL, NULL, $$ SELECT create_monthly_fee_batch(current_date)::text $$), 'ERR 42501');
SELECT pg_temp.chk('B3 future month refused', pg_temp.as_sess('authenticated', pg_temp.u(299), 'dustin@otterquote.com',
  $$ SELECT create_monthly_fee_batch((date_trunc('month', now()) + interval '2 months')::date)::text $$), 'ERR 22023');
SELECT pg_temp.chk('B4 admin run: payouts created / events batched / total cents', pg_temp.as_sess('authenticated', pg_temp.u(299), 'dustin@otterquote.com',
  $$ SELECT (r->>'payouts_created') || '/' || (r->>'events_batched') || '/' || (r->>'total_cents') FROM (SELECT create_monthly_fee_batch(current_date) r) x $$), '2/12/6000');
SELECT pg_temp.chk('B5 P ($30): one payout, amount, type, referral_id null, status', pg_temp.q(format(
  $$ SELECT count(*) || '/' || max(amount) || '/' || max(payout_type) || '/' || bool_and(referral_id IS NULL) || '/' || max(status) FROM payout_approvals WHERE partner_id = %L AND payout_type = 'measurement_fees_monthly' $$, pg_temp.u(105))),
  '1/30.00/measurement_fees_monthly/true/pending_approval');
SELECT pg_temp.chk('B5 P events batched and linked', pg_temp.q(format(
  $$ SELECT count(*) FROM partner_fee_events e WHERE e.referral_agent_id = %L AND e.status = 'batched' AND e.payout_approval_id IN (SELECT id FROM payout_approvals WHERE partner_id = %L AND payout_type = 'measurement_fees_monthly') $$, pg_temp.u(105), pg_temp.u(105))), '6');
SELECT pg_temp.chk('B6 rerun creates nothing', pg_temp.as_sess('authenticated', pg_temp.u(299), 'dustin@otterquote.com',
  $$ SELECT (r->>'payouts_created') || '/' || (r->>'events_batched') FROM (SELECT create_monthly_fee_batch(current_date) r) x $$), '0/0');
SELECT pg_temp.chk('B6 payout rows after rerun (P and R only)', pg_temp.q($$ SELECT count(*) FROM payout_approvals WHERE payout_type = 'measurement_fees_monthly' $$), '2');
SELECT pg_temp.chk('B7 Q ($20): no payout, 4 events still accrued', pg_temp.q(format(
  $$ SELECT (SELECT count(*) FROM payout_approvals WHERE partner_id = %L) || '/' || (SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L AND status = 'accrued') $$, pg_temp.u(106), pg_temp.u(106))), '0/4');
SELECT pg_temp.chk('B8 W (payments_blocked, $30): no payout, 6 events still accrued', pg_temp.q(format(
  $$ SELECT (SELECT count(*) FROM payout_approvals WHERE partner_id = %L) || '/' || (SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L AND status = 'accrued') $$, pg_temp.u(108), pg_temp.u(108))), '0/6');
SELECT pg_temp.chk('B9 A ($12), B, K, T rolled over: no payout rows for them', pg_temp.q(format(
  $$ SELECT count(*) FROM payout_approvals WHERE payout_type = 'measurement_fees_monthly' AND partner_id IN (%L, %L, %L, %L) $$, pg_temp.u(101), pg_temp.u(102), pg_temp.u(104), pg_temp.u(109))), '0');

-- mark paid ----------------------------------------------------------------------------------------------------------------------------------------
CREATE TEMP TABLE pp(k text PRIMARY KEY, id uuid) ON COMMIT DROP;
INSERT INTO pp SELECT 'p', id FROM payout_approvals WHERE partner_id = pg_temp.u(105) AND payout_type = 'measurement_fees_monthly';
INSERT INTO pp SELECT 'r', id FROM payout_approvals WHERE partner_id = pg_temp.u(107) AND payout_type = 'measurement_fees_monthly';
SELECT pg_temp.chk('P1 payout not yet paid: flip returns 0, events stay batched', pg_temp.as_sess('service_role', NULL, NULL,
  format($$ SELECT public.partner_fee_events_mark_paid(%L)::text $$, (SELECT id FROM pp WHERE k = 'p'))) || '/' || pg_temp.q(format(
  $$ SELECT count(*) FROM partner_fee_events WHERE payout_approval_id = %L AND status = 'batched' $$, (SELECT id FROM pp WHERE k = 'p'))), '0/6');
SELECT pg_temp.chk('P2 non-service caller refused', pg_temp.as_sess('authenticated', pg_temp.u(299), 'dustin@otterquote.com',
  format($$ SELECT public.partner_fee_events_mark_paid(%L)::text $$, (SELECT id FROM pp WHERE k = 'p'))), 'ERR 42501');
UPDATE payout_approvals SET status = 'approved' WHERE id = (SELECT id FROM pp WHERE k = 'p');
UPDATE payout_approvals SET status = 'paid', paid_at = now() WHERE id = (SELECT id FROM pp WHERE k = 'p');
SELECT pg_temp.chk('P3 mark-payout-paid flips: 6 events paid with paid_at; a second call flips 0', pg_temp.as_sess('service_role', NULL, NULL,
  format($$ SELECT public.partner_fee_events_mark_paid(%L)::text $$, (SELECT id FROM pp WHERE k = 'p'))) || '/' || pg_temp.q(format(
  $$ SELECT count(*) FROM partner_fee_events WHERE payout_approval_id = %L AND status = 'paid' AND paid_at IS NOT NULL $$, (SELECT id FROM pp WHERE k = 'p'))) || '/' || pg_temp.as_sess('service_role', NULL, NULL,
  format($$ SELECT public.partner_fee_events_mark_paid(%L)::text $$, (SELECT id FROM pp WHERE k = 'p'))), '6/6/0');
SELECT pg_temp.chk('P3 R''s events untouched by P''s flip', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE payout_approval_id = %L AND status = 'batched' $$, (SELECT id FROM pp WHERE k = 'r'))), '6');
SELECT pg_temp.chk('P4 P stats after paid: $5 paid 3000, accrued 0', pg_temp.as_sess('authenticated', pg_temp.u(205), 'gh3229-5@example.invalid',
  $$ SELECT measurement_fees_paid_cents || '/' || measurement_fees_accrued_cents || '/' || earnings_paid_cents FROM get_partner_dashboard_stats() $$), '3000/0/3000');

-- rejected batch payout releases its events, the next run re-batches them ------------------------------------------------------------------------------
UPDATE payout_approvals SET status = 'rejected', rejected_at = now() WHERE id = (SELECT id FROM pp WHERE k = 'r');
SELECT pg_temp.chk('R1 rejected payout: 6 events back to accrued, link cleared', pg_temp.q(format(
  $$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L AND status = 'accrued' AND payout_approval_id IS NULL $$, pg_temp.u(107))), '6');
SELECT pg_temp.chk('R1 next run re-batches them: payouts created', pg_temp.as_sess('authenticated', pg_temp.u(299), 'dustin@otterquote.com',
  $$ SELECT (r->>'payouts_created') || '/' || (r->>'events_batched') FROM (SELECT create_monthly_fee_batch(current_date) r) x $$), '1/6');

-- the job-completion rebate (refund) does not touch the fee ------------------------------------------------------------------------------------------------
UPDATE hover_orders SET rebate_paid_at = now(), rebate_due = false WHERE id = (SELECT id FROM o WHERE k = 'q1');
UPDATE hover_orders SET rebate_paid_at = now(), rebate_due = false WHERE id = (SELECT id FROM o WHERE k = 'p1');
SELECT pg_temp.chk('V1 rebate_paid_at set on an accrued event: stays accrued, no voided_at; Q accrued still 4', pg_temp.q(format(
  $$ SELECT (SELECT status || '/' || (voided_at IS NULL) FROM partner_fee_events WHERE hover_order_id = %L) || '/' || (SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L AND status = 'accrued') $$,
  (SELECT id FROM o WHERE k = 'q1'), pg_temp.u(106))), 'accrued/true/4');
SELECT pg_temp.chk('V2 rebate_paid_at set on a paid event: stays paid', pg_temp.q(format($$ SELECT status FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'p1'))), 'paid');

DO $f$
DECLARE s text; n_ok int; n_diff int;
BEGIN
  SELECT string_agg(rpad(k, 100) || ' | got ' || got || ' | want ' || want || ' | ' || CASE WHEN got = want THEN 'OK' ELSE 'DIFF' END, E'\n' ORDER BY k),
         count(*) FILTER (WHERE got = want), count(*) FILTER (WHERE got <> want)
    INTO s, n_ok, n_diff FROM _r;
  RAISE EXCEPTION E'GH3229 PROOF (forced rollback)\n%\nTALLY: % OK, % DIFF', s, n_ok, n_diff USING ERRCODE = 'P0U01';
END $f$;
