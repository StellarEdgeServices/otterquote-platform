-- gh-3239 proof: Partner Agreement v4 acceptance. THROWAWAY Postgres only (see gh3239_partner_agreement_v4_proof_run.sh).
-- Phase-aware: every row states what it expects BEFORE the forward file (BASELINE / ROLLBACK) and AFTER it (AFTER / REAPPLIED).
-- The BASELINE expectations are the negative controls: they show the defect or the absent behavior each AFTER row proves fixed
-- (signups stamp v3, a partner can PATCH a forged v4 + timestamp into their own row, no accept RPC exists).
-- Runs inside BEGIN ... ROLLBACK, so it leaves the database as it found it and can run once per phase.
-- Output: one line per check "name|phase|expected|actual|PASS or FAIL", then "FAILING=<n> of <m>".
\set ON_ERROR_STOP on
\pset footer off
BEGIN;
SELECT (to_regprocedure('public.accept_partner_agreement_v4()') IS NOT NULL)::text AS after \gset
CREATE TEMP TABLE proof_r (n serial, name text, expected text, actual text);
CREATE FUNCTION pg_temp.chk(p_name text, p_before text, p_after text, p_actual text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO proof_r (name, expected, actual)
  VALUES (p_name, CASE WHEN current_setting('proof.after') = 'true' THEN p_after ELSE p_before END, COALESCE(p_actual, '<null>'));
$f$;
SELECT set_config('proof.after', :'after', true);
SELECT set_config('request.headers', '{"x-forwarded-for": "203.0.113.9", "user-agent": "proof-ua"}', true);

-- seed (as owner) ------------------------------------------------------------------------------------------------------------------------
INSERT INTO public.referral_agents (id, user_id, agent_type, first_name, last_name, email, partner_agreement_version, partner_agreement_accepted_at, partner_agreement_attestation, needs_partner_reacceptance) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 're_agent',        'Ann', 'Agent',     'ann@proof.invalid', 'v3-2026-09', '2026-09-26 12:00+00', '{"v3-2026-09": {"accepted_at": "2026-09-26T12:00:00+00:00"}}', true),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000002', 'home_inspector',  'Ian', 'Inspector', 'ian@proof.invalid', 'v3-2026-09', '2026-09-26 12:00+00', '{"v3-2026-09": {"accepted_at": "2026-09-26T12:00:00+00:00"}}', false),
  ('aaaaaaaa-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000003', 'customer',        'Cal', 'Customer',  'cal@proof.invalid', NULL,         NULL,                  '{}', false),
  ('aaaaaaaa-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000004', 'insurance_agent', 'Dee', 'Direct',    'dee@proof.invalid', 'v3-2026-09', '2026-09-26 12:00+00', '{"v3-2026-09": {"accepted_at": "2026-09-26T12:00:00+00:00"}}', false);

-- R1-R3: the function bodies --------------------------------------------------------------------------------------------------------------
SELECT pg_temp.chk('R1 register_partner body md5', '042da30fdc75423c32383035b27f2fa4', 'f4affeb5b17e2b4d242ce452686ada4d',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.register_partner(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,text,text,text,boolean,text,text,text,text)'::regprocedure));
SELECT pg_temp.chk('R2 register_partner still SECURITY DEFINER + pinned search_path + anon EXECUTE', 'true|search_path=public, pg_temp|true', 'true|search_path=public, pg_temp|true',
  (SELECT p.prosecdef::text || '|' || array_to_string(p.proconfig, ',') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
     FROM pg_proc p WHERE p.oid = 'public.register_partner(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,text,text,text,boolean,text,text,text,text)'::regprocedure));
SELECT pg_temp.chk('R3 accept_partner_agreement_v4: DEFINER, pinned search_path, authenticated yes, anon no, PUBLIC no', 'absent', 'true|search_path=public, pg_temp|true|false|false',
  (SELECT COALESCE((SELECT p.prosecdef::text || '|' || array_to_string(p.proconfig, ',') || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
     || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
     || '|' || (SELECT count(*) > 0 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')::text
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.accept_partner_agreement_v4()')), 'absent')));

-- S1-S3: new signups ---------------------------------------------------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"role": "anon"}', true);
SET LOCAL ROLE anon;
SELECT set_config('proof.s1', (public.register_partner('re_agent', 'New', 'Realtor', 'newrealtor@proof.invalid') ->> 'id'), true);
SELECT set_config('proof.s2', (public.register_partner('home_inspector', 'New', 'Inspector', 'newinspector@proof.invalid') ->> 'id'), true);
RESET ROLE;
SELECT pg_temp.chk('S1 anon re_agent signup records version, timestamp, attestation key', 'v3-2026-09|true|v3-2026-09', 'v4-2026-10|true|v4-2026-10',
  (SELECT partner_agreement_version || '|' || (partner_agreement_accepted_at IS NOT NULL)::text || '|' || (SELECT string_agg(k, ',') FROM jsonb_object_keys(partner_agreement_attestation) k)
     FROM public.referral_agents WHERE id = current_setting('proof.s1')::uuid));
SELECT pg_temp.chk('S2 home_inspector signup stays on the inspector agreement v3-2026-09', 'v3-2026-09', 'v3-2026-09',
  (SELECT partner_agreement_version FROM public.referral_agents WHERE id = current_setting('proof.s2')::uuid));
SELECT set_config('request.jwt.claims', '{"role": "service_role"}', true);
SET LOCAL ROLE service_role;
SELECT set_config('proof.s3', (public.register_partner('re_agent', 'Meta', 'Lead', 'metalead@proof.invalid') ->> 'id'), true);
RESET ROLE;
SELECT pg_temp.chk('S3 service_role (Meta webhook) signup still stamps no acceptance', '<null>|pending', '<null>|pending',
  (SELECT COALESCE(partner_agreement_version, '<null>') || '|' || status FROM public.referral_agents WHERE id = current_setting('proof.s3')::uuid));

-- A1-A8: click-to-accept -----------------------------------------------------------------------------------------------------------------
-- A1: v3 partner accepts
SELECT set_config('request.jwt.claims', '{"role": "authenticated", "sub": "11111111-0000-0000-0000-000000000001"}', true);
SET LOCAL ROLE authenticated;
DO $d$ BEGIN
  PERFORM set_config('proof.a1', (SELECT public.accept_partner_agreement_v4()::text), true);
EXCEPTION WHEN others THEN PERFORM set_config('proof.a1', 'ERR ' || SQLSTATE, true);
END $d$;
RESET ROLE;
SELECT pg_temp.chk('A1 accept call result', 'ERR 42883', 'v4-2026-10|false',
  CASE WHEN current_setting('proof.a1') LIKE 'ERR%' THEN current_setting('proof.a1')
       ELSE (current_setting('proof.a1')::jsonb ->> 'agreement_version') || '|' || (current_setting('proof.a1')::jsonb ->> 'already_accepted') END);
SELECT pg_temp.chk('A2 v3 partner row after accept: version|timestamp moved|v3 key kept|v4 key ip/ua|reaccept flag cleared',
  'v3-2026-09|false|true|<null>|true', 'v4-2026-10|true|true|203.0.113.9 proof-ua|false',
  (SELECT partner_agreement_version || '|' || (partner_agreement_accepted_at > '2026-10-01')::text || '|' || (partner_agreement_attestation ? 'v3-2026-09')::text
          || '|' || COALESCE((partner_agreement_attestation -> 'v4-2026-10' ->> 'accepted_ip') || ' ' || (partner_agreement_attestation -> 'v4-2026-10' ->> 'accepted_ua'), '<null>')
          || '|' || needs_partner_reacceptance::text
     FROM public.referral_agents WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'));
SELECT set_config('proof.a2ts', (SELECT partner_agreement_accepted_at::text FROM public.referral_agents WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'), true);
-- A3: second click is idempotent (same timestamp, already_accepted true)
SET LOCAL ROLE authenticated;
DO $d$ BEGIN
  PERFORM set_config('proof.a3', (SELECT public.accept_partner_agreement_v4()::text), true);
EXCEPTION WHEN others THEN PERFORM set_config('proof.a3', 'ERR ' || SQLSTATE, true);
END $d$;
RESET ROLE;
SELECT pg_temp.chk('A3 second click: already_accepted|returned timestamp = stored|stored timestamp unchanged', 'ERR 42883', 'true|true|true',
  CASE WHEN current_setting('proof.a3') LIKE 'ERR%' THEN current_setting('proof.a3')
       ELSE (current_setting('proof.a3')::jsonb ->> 'already_accepted') || '|'
         || ((current_setting('proof.a3')::jsonb ->> 'accepted_at')::timestamptz = current_setting('proof.a2ts')::timestamptz)::text || '|'
         || ((SELECT partner_agreement_accepted_at FROM public.referral_agents WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001') = current_setting('proof.a2ts')::timestamptz)::text END);
SELECT pg_temp.chk('A4 another partner''s row untouched by A1', 'v3-2026-09', 'v3-2026-09',
  (SELECT partner_agreement_version FROM public.referral_agents WHERE id = 'aaaaaaaa-0000-0000-0000-000000000004'));
-- A5: customer (refer-a-friend) accepts
SELECT set_config('request.jwt.claims', '{"role": "authenticated", "sub": "11111111-0000-0000-0000-000000000003"}', true);
SET LOCAL ROLE authenticated;
DO $d$ BEGIN
  PERFORM set_config('proof.a5', (SELECT public.accept_partner_agreement_v4()::text), true);
EXCEPTION WHEN others THEN PERFORM set_config('proof.a5', 'ERR ' || SQLSTATE, true);
END $d$;
RESET ROLE;
SELECT pg_temp.chk('A5 customer accepts: row version', '<null>', 'v4-2026-10',
  (SELECT partner_agreement_version FROM public.referral_agents WHERE id = 'aaaaaaaa-0000-0000-0000-000000000003'));
-- A6: home inspector is refused, row unchanged
SELECT set_config('request.jwt.claims', '{"role": "authenticated", "sub": "11111111-0000-0000-0000-000000000002"}', true);
SET LOCAL ROLE authenticated;
DO $d$ BEGIN
  PERFORM public.accept_partner_agreement_v4(); PERFORM set_config('proof.a6', 'ok', true);
EXCEPTION WHEN others THEN PERFORM set_config('proof.a6', 'ERR ' || SQLSTATE, true);
END $d$;
RESET ROLE;
SELECT pg_temp.chk('A6 home inspector refused|row stays v3', 'ERR 42883|v3-2026-09', 'ERR 22023|v3-2026-09',
  current_setting('proof.a6') || '|' || (SELECT partner_agreement_version FROM public.referral_agents WHERE id = 'aaaaaaaa-0000-0000-0000-000000000002'));
-- A7: signed-in user with no partner row
SELECT set_config('request.jwt.claims', '{"role": "authenticated", "sub": "11111111-0000-0000-0000-000000000099"}', true);
SET LOCAL ROLE authenticated;
DO $d$ BEGIN
  PERFORM public.accept_partner_agreement_v4(); PERFORM set_config('proof.a7', 'ok', true);
EXCEPTION WHEN others THEN PERFORM set_config('proof.a7', 'ERR ' || SQLSTATE, true);
END $d$;
RESET ROLE;
SELECT pg_temp.chk('A7 no partner record', 'ERR 42883', 'ERR P0002', current_setting('proof.a7'));
-- A8: anon cannot call it (no EXECUTE), and an authenticated role with no sub is refused inside
SELECT set_config('request.jwt.claims', '{"role": "anon"}', true);
SET LOCAL ROLE anon;
DO $d$ BEGIN
  PERFORM public.accept_partner_agreement_v4(); PERFORM set_config('proof.a8', 'ok', true);
EXCEPTION WHEN others THEN PERFORM set_config('proof.a8', 'ERR ' || SQLSTATE, true);
END $d$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role": "authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $d$ BEGIN
  PERFORM public.accept_partner_agreement_v4(); PERFORM set_config('proof.a8b', 'ok', true);
EXCEPTION WHEN others THEN PERFORM set_config('proof.a8b', 'ERR ' || SQLSTATE, true);
END $d$;
RESET ROLE;
SELECT pg_temp.chk('A8 anon call|authenticated without uid', 'ERR 42883|ERR 42883', 'ERR 42501|ERR 42501',
  current_setting('proof.a8') || '|' || current_setting('proof.a8b'));

-- L1-L4: column lock (direct PATCH) -----------------------------------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"role": "authenticated", "sub": "11111111-0000-0000-0000-000000000004"}', true);
SET LOCAL ROLE authenticated;
DO $d$ BEGIN
  UPDATE public.referral_agents SET partner_agreement_version = 'v4-2026-10', partner_agreement_accepted_at = '2026-01-01 00:00+00'
   WHERE user_id = auth.uid();
  PERFORM set_config('proof.l1', 'ok', true);
EXCEPTION WHEN others THEN PERFORM set_config('proof.l1', 'ERR ' || SQLSTATE, true);
END $d$;
DO $d$ BEGIN
  UPDATE public.referral_agents SET partner_agreement_attestation = '{"v4-2026-10": {"accepted_at": "2026-01-01T00:00:00+00:00"}}' WHERE user_id = auth.uid();
  PERFORM set_config('proof.l2', 'ok', true);
EXCEPTION WHEN others THEN PERFORM set_config('proof.l2', 'ERR ' || SQLSTATE, true);
END $d$;
DO $d$ BEGIN
  UPDATE public.referral_agents SET first_name = 'Deanna', bio = 'proof' WHERE user_id = auth.uid();
  PERFORM set_config('proof.l3', 'ok', true);
EXCEPTION WHEN others THEN PERFORM set_config('proof.l3', 'ERR ' || SQLSTATE, true);
END $d$;
RESET ROLE;
-- BASELINE: the forged write lands (the hole this file closes). AFTER: refused, and the row is still v3.
SELECT pg_temp.chk('L1 partner PATCHes own version + back-dated timestamp', 'ok', 'ERR 42501', current_setting('proof.l1'));
SELECT pg_temp.chk('L2 partner PATCHes own attestation', 'ok', 'ERR 42501', current_setting('proof.l2'));
SELECT pg_temp.chk('L3 partner profile edit still allowed', 'ok', 'ok', current_setting('proof.l3'));
SELECT pg_temp.chk('L4 row after the PATCH attempts: version|attestation has v4', 'v4-2026-10|true', 'v3-2026-09|false',
  (SELECT partner_agreement_version || '|' || (partner_agreement_attestation ? 'v4-2026-10')::text FROM public.referral_agents WHERE id = 'aaaaaaaa-0000-0000-0000-000000000004'));
SELECT set_config('request.jwt.claims', '{"role": "service_role"}', true);
SET LOCAL ROLE service_role;
DO $d$ BEGIN
  UPDATE public.referral_agents SET needs_partner_reacceptance = true WHERE id = 'aaaaaaaa-0000-0000-0000-000000000004';
  PERFORM set_config('proof.l5', 'ok', true);
EXCEPTION WHEN others THEN PERFORM set_config('proof.l5', 'ERR ' || SQLSTATE, true);
END $d$;
RESET ROLE;
SELECT pg_temp.chk('L5 service_role may still set the agreement columns', 'ok', 'ok', current_setting('proof.l5'));

-- G1-G4: accrual gate helper --------------------------------------------------------------------------------------------------------------
DO $d$ BEGIN
  PERFORM set_config('proof.g', (
    SELECT (public.partner_v4_accepted_at('aaaaaaaa-0000-0000-0000-000000000001') IS NOT NULL)::text || '|'
        || (public.partner_v4_accepted_at('aaaaaaaa-0000-0000-0000-000000000002') IS NULL)::text || '|'
        || (public.partner_v4_accepted_at('aaaaaaaa-0000-0000-0000-000000000004') IS NULL)::text || '|'
        || (public.partner_v4_accepted_at('aaaaaaaa-0000-0000-0000-0000000000ff') IS NULL)::text || '|'
        || (public.partner_v4_accepted_at('aaaaaaaa-0000-0000-0000-000000000001') = current_setting('proof.a2ts')::timestamptz)::text), true);
EXCEPTION WHEN others THEN PERFORM set_config('proof.g', 'ERR ' || SQLSTATE, true);
END $d$;
SELECT pg_temp.chk('G1 partner_v4_accepted_at: v4 acceptor set|inspector null|v3 null|unknown null|equals acceptance time', 'ERR 42883', 'true|true|true|true|true', current_setting('proof.g'));
SELECT pg_temp.chk('G2 partner_v4_accepted_at not executable by authenticated or anon', 'absent', 'false|false',
  (SELECT COALESCE((SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
     FROM pg_proc p WHERE p.oid = to_regprocedure('public.partner_v4_accepted_at(uuid)')), 'absent')));
SELECT pg_temp.chk('G3 partner_agreement_current_version()', 'absent', 'v4-2026-10',
  (SELECT CASE WHEN to_regprocedure('public.partner_agreement_current_version()') IS NULL THEN 'absent' END));
DO $d$ BEGIN
  IF to_regprocedure('public.partner_agreement_current_version()') IS NOT NULL THEN
    EXECUTE 'UPDATE proof_r SET actual = public.partner_agreement_current_version() WHERE name LIKE ''G3 %''';
  END IF;
END $d$;

SELECT name || '|' || CASE WHEN current_setting('proof.after') = 'true' THEN 'after' ELSE 'before' END || '|' || expected || '|' || actual || '|'
       || CASE WHEN expected = actual THEN 'PASS' ELSE 'FAIL' END
  FROM proof_r ORDER BY n;
SELECT 'FAILING=' || count(*) FILTER (WHERE expected IS DISTINCT FROM actual) || ' of ' || count(*) FROM proof_r;
ROLLBACK;
