-- gh-3245 proof: get_or_create_customer_referral_code() returns no code until the customer has accepted Partner Agreement v4. THROWAWAY Postgres only (see the _run.sh).
-- Phase-aware: BEFORE = the live body (BASELINE / ROLLBACK), AFTER = the gh3245 body (AFTER / REAPPLIED). The BEFORE column is the negative control:
-- case A and B return a code to a customer who never accepted, which is exactly what the gate removes.
-- Runs inside BEGIN ... ROLLBACK. Output: "name|phase|expected|actual|PASS or FAIL" per check, then "FAILING=<n> of <m>".
\set ON_ERROR_STOP on
BEGIN;
SELECT (position('gh-3245' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_or_create_customer_referral_code()'::regprocedure)) > 0)::text AS after \gset
CREATE TEMP TABLE proof_r (n serial, name text, expected text, actual text);
CREATE FUNCTION pg_temp.chk(p_name text, p_before text, p_after text, p_actual text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO proof_r (name, expected, actual)
  VALUES (p_name, CASE WHEN current_setting('proof.after') = 'true' THEN p_after ELSE p_before END, COALESCE(p_actual, '<null>'));
$f$;
SELECT set_config('proof.after', :'after', true);
-- the caller: a JWT as PostgREST sets it (auth.uid() / auth.jwt() read request.jwt.claims)
CREATE FUNCTION pg_temp.as_user(p_uid uuid, p_email text) RETURNS void LANGUAGE sql AS $f$
  SELECT set_config('request.jwt.claims', jsonb_build_object('sub', p_uid, 'email', p_email, 'role', 'authenticated')::text, true)
$f$;
-- "has_code|v4_required|created|rows" for one call: has_code = unique_code is non-null; rows = this user's customer rows afterwards
CREATE FUNCTION pg_temp.call(p_uid uuid) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r jsonb;
BEGIN
  r := public.get_or_create_customer_referral_code();
  RETURN (r ->> 'unique_code' IS NOT NULL)::text || '|' || COALESCE(r ->> 'v4_acceptance_required', 'absent') || '|' || (r ->> 'created')
      || '|' || (SELECT count(*) FROM public.referral_agents WHERE user_id = p_uid AND agent_type = 'customer')::text;
END $f$;

-- users: U1 brand new (no row), U2 existing customer row never accepted, U3 accepted v4, U4 accepted v3 only, U5 for the full accept flow
INSERT INTO public.referral_agents (agent_type, first_name, last_name, email, user_id, partner_agreement_version, partner_agreement_accepted_at, partner_agreement_attestation) VALUES
  ('customer', 'U', 'Two',  'u2@proof.invalid', 'dddddddd-0000-0000-0000-000000000002', NULL, NULL, '{}'),
  ('customer', 'U', 'Three','u3@proof.invalid', 'dddddddd-0000-0000-0000-000000000003', 'v4-2026-10', '2026-11-01T00:00:00Z', '{"v4-2026-10": {"accepted_at": "2026-11-01T00:00:00+00:00"}}'),
  ('customer', 'U', 'Four', 'u4@proof.invalid', 'dddddddd-0000-0000-0000-000000000004', 'v3-2026-09', '2026-09-26T12:00:00Z', '{"v3-2026-09": {}}');

SELECT pg_temp.as_user('dddddddd-0000-0000-0000-000000000001', 'u1@proof.invalid');
SELECT pg_temp.chk('A brand-new customer: the row is created, no code returned (acceptance required)', 'true|absent|true|1', 'false|true|true|1', pg_temp.call('dddddddd-0000-0000-0000-000000000001'));
SELECT pg_temp.chk('A2 second call, still not accepted: same refusal, still one row', 'true|absent|false|1', 'false|true|false|1', pg_temp.call('dddddddd-0000-0000-0000-000000000001'));

SELECT pg_temp.as_user('dddddddd-0000-0000-0000-000000000002', 'u2@proof.invalid');
SELECT pg_temp.chk('B existing customer row that never accepted v4: no code returned', 'true|absent|false|1', 'false|true|false|1', pg_temp.call('dddddddd-0000-0000-0000-000000000002'));

SELECT pg_temp.as_user('dddddddd-0000-0000-0000-000000000003', 'u3@proof.invalid');
SELECT pg_temp.chk('C customer who accepted v4: code returned, exactly as before', 'true|absent|false|1', 'true|absent|false|1', pg_temp.call('dddddddd-0000-0000-0000-000000000003'));

SELECT pg_temp.as_user('dddddddd-0000-0000-0000-000000000004', 'u4@proof.invalid');
SELECT pg_temp.chk('D customer who accepted only v3-2026-09: no code (v4 is the required version)', 'true|absent|false|1', 'false|true|false|1', pg_temp.call('dddddddd-0000-0000-0000-000000000004'));

-- E: the whole first-time flow the pages run: get-or-create (row appears), accept_partner_agreement_v4() (finds the row), get-or-create again (code)
SELECT pg_temp.as_user('dddddddd-0000-0000-0000-000000000005', 'u5@proof.invalid');
SELECT (public.get_or_create_customer_referral_code() ->> 'created') AS e_first_created \gset
SELECT (public.accept_partner_agreement_v4() ->> 'agreement_version') AS e_accept_version \gset
SELECT pg_temp.chk('E accept flow: row created by the first call, acceptance recorded on it, second call returns the code', 'true|v4-2026-10', 'true|v4-2026-10',
  (public.get_or_create_customer_referral_code() ->> 'unique_code' IS NOT NULL)::text || '|' || :'e_accept_version');
SELECT pg_temp.chk('E2 the code returned after acceptance is the row''s own stored code (stable, not regenerated)', 'true', 'true',
  ((public.get_or_create_customer_referral_code() ->> 'unique_code') = (SELECT unique_code FROM public.referral_agents WHERE user_id = 'dddddddd-0000-0000-0000-000000000005' AND agent_type = 'customer'))::text);

-- H, I (gh-3245 review F2): what "accepted" means to the server is partner_v4_accepted_at(customer row). The refer pages (PR #3327) read the same test:
-- the v4 key needs a non-empty accepted_at, the version column needs partner_agreement_accepted_at. These two shapes are the ones the pages once read as accepted.
-- H: a PARTNER row (other agent_type, same user_id) accepted v4, no customer row: the customer row is created and it is NOT accepted.
INSERT INTO public.referral_agents (agent_type, first_name, last_name, email, user_id, partner_agreement_version, partner_agreement_accepted_at, partner_agreement_attestation) VALUES
  ('influencer', 'U', 'Seven', 'u7-partner@proof.invalid', 'dddddddd-0000-0000-0000-000000000007', 'v4-2026-10', '2026-11-01T00:00:00Z', '{"v4-2026-10": {"accepted_at": "2026-11-01T00:00:00+00:00"}}');
SELECT pg_temp.as_user('dddddddd-0000-0000-0000-000000000007', 'u7@proof.invalid');
SELECT pg_temp.chk('H partner row accepted v4, no customer row: the customer row is created and is not accepted (no code)', 'true|absent|true|1', 'false|true|true|1', pg_temp.call('dddddddd-0000-0000-0000-000000000007'));
-- I: customer row with the v4 attestation key but no accepted_at, version not v4: not accepted; accept_partner_agreement_v4() stamps nothing (known limit, unchanged by this PR)
INSERT INTO public.referral_agents (agent_type, first_name, last_name, email, user_id, partner_agreement_version, partner_agreement_accepted_at, partner_agreement_attestation) VALUES
  ('customer', 'U', 'Eight', 'u8@proof.invalid', 'dddddddd-0000-0000-0000-000000000008', 'v3-2026-09', '2026-09-26T12:00:00Z', '{"v3-2026-09": {}, "v4-2026-10": {}}');
SELECT pg_temp.as_user('dddddddd-0000-0000-0000-000000000008', 'u8@proof.invalid');
SELECT pg_temp.chk('I customer row with a v4 key but no accepted_at: not accepted (no code)', 'true|absent|false|1', 'false|true|false|1', pg_temp.call('dddddddd-0000-0000-0000-000000000008'));
SELECT COALESCE(public.accept_partner_agreement_v4() ->> 'accepted_at', 'none') AS i_accept_at \gset
SELECT pg_temp.chk('I2 accept on that row returns no accepted_at (known limit: the page then shows its existing acceptance error, logged)', 'none', 'none', :'i_accept_at');

-- F: unchanged guards
SELECT set_config('request.jwt.claims', '', true);
DO $t$ BEGIN
  BEGIN PERFORM public.get_or_create_customer_referral_code(); PERFORM set_config('proof.f', 'no error', true);
  EXCEPTION WHEN OTHERS THEN PERFORM set_config('proof.f', SQLERRM, true); END;
END $t$;
SELECT pg_temp.chk('F no session: not_authenticated, unchanged', 'not_authenticated', 'not_authenticated', current_setting('proof.f'));
SELECT pg_temp.as_user('dddddddd-0000-0000-0000-000000000006', '');
DO $t$ BEGIN
  BEGIN PERFORM public.get_or_create_customer_referral_code(); PERFORM set_config('proof.g', 'no error', true);
  EXCEPTION WHEN OTHERS THEN PERFORM set_config('proof.g', left(SQLERRM, 13), true); END;
END $t$;
SELECT pg_temp.chk('G session without an email: missing_email, unchanged, no row created', 'missing_email|0', 'missing_email|0',
  current_setting('proof.g') || '|' || (SELECT count(*) FROM public.referral_agents WHERE user_id = 'dddddddd-0000-0000-0000-000000000006')::text);

SELECT name || '|' || CASE WHEN current_setting('proof.after') = 'true' THEN 'after' ELSE 'before' END || '|' || expected || '|' || actual || '|' ||
       CASE WHEN expected = actual THEN 'PASS' ELSE 'FAIL' END FROM proof_r ORDER BY n;
SELECT 'FAILING=' || count(*) FILTER (WHERE expected <> actual) || ' of ' || count(*) FROM proof_r;
ROLLBACK;
