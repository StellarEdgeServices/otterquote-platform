-- gh-3073 proof: accept_cpa() stamps contractors.agreement_version from a server-held single-row source (D-366), never from the client.
-- ONE transaction that ends in ROLLBACK; nothing commits. The last statement before ROLLBACK is the result table; every row's ok must be true.
-- Rows prefixed [expect-differs] are the controls where BASELINE (gh-2995 function, forward NOT applied) and AFTER (forward applied) are meant to differ.
-- NEGATIVE CONTROL: against the gh-2995 function (BASELINE) a pre-approval onboarding leaves agreement_version NULL (rows P1/P1a).
-- Usage:
--   throwaway Postgres: bash supabase/tests/gh3073_agreement_version_proof_run.sh   (BASELINE -> AFTER -> ROLLBACK -> REAPPLIED)
--   The two contractors A and B are the two seeded is_test rows of the gh-2995 throwaway schema (by id). The pre-approval onboarding
--   uses fresh auth users inserted below. Not intended for production: the throwaway schema models only what gh-2995 models.
BEGIN;

CREATE TEMP TABLE proof_r (n serial PRIMARY KEY, label text, got text, expected text, ok boolean, detail text);
CREATE TEMP TABLE proof_ctx AS
  SELECT (array_agg(id ORDER BY id))[1] AS a, (array_agg(user_id ORDER BY id))[1] AS ua,
         (array_agg(id ORDER BY id))[2] AS b, (array_agg(user_id ORDER BY id))[2] AS ub
  FROM (SELECT id, user_id FROM public.contractors WHERE is_test AND user_id IS NOT NULL ORDER BY id LIMIT 2) t;
GRANT SELECT ON proof_ctx TO PUBLIC;

CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_email text, p_headers text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text, true);
  PERFORM set_config('request.headers', coalesce(p_headers, '{}'), true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN 'ok rows=' || n;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 90);
  END;
END $f$;

CREATE FUNCTION pg_temp.rec(p_label text, p_got text, p_exp text, p_detail text) RETURNS void
LANGUAGE sql AS $f$ INSERT INTO proof_r(label,got,expected,ok,detail) VALUES (p_label,p_got,p_exp,p_got IS NOT DISTINCT FROM p_exp,p_detail) $f$;

CREATE FUNCTION pg_temp.has_src() RETURNS boolean LANGUAGE sql AS $f$ SELECT to_regclass('public.agreement_version_current') IS NOT NULL $f$;
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, '<null>'); EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE; END $f$;
CREATE FUNCTION pg_temp.nacc(p_cid uuid) RETURNS text LANGUAGE sql AS
  $f$ SELECT count(*)::text FROM public.contractor_cpa_acceptances WHERE contractor_id = p_cid $f$;

CREATE FUNCTION pg_temp.run() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  a uuid; ua uuid; b uuid; ub uuid; r text;
  v text := 'v1-2026-04';          -- the CPA version (cpa_versions.is_current)
  s text := 'v2-2026-10';          -- the server's current AGREEMENT version (D-366)
  fixed boolean := pg_temp.has_src();
  h1 text := '{"x-forwarded-for":"203.0.113.7, 10.0.0.1","user-agent":"UA-first/1.0"}';
  h2 text := '{"x-forwarded-for":"198.51.100.9","user-agent":"UA-second/2.0"}';
  cu constant uuid := 'cccccccc-1111-4000-8000-000000000003';
  cc constant uuid := 'cccccccc-0000-4000-8000-000000000003';
BEGIN
  SELECT c.a, c.ua, c.b, c.ub INTO a, ua, b, ub FROM proof_ctx c;
  IF a IS NULL OR b IS NULL THEN RAISE EXCEPTION 'proof needs two is_test contractors'; END IF;
  UPDATE public.contractors SET agreement_accepted_at = NULL, agreement_version = NULL, cpa_version = v, cpa_accepted_at = NULL,
         needs_cpa_reattestation = false WHERE id IN (a, b);
  DELETE FROM public.activity_log WHERE user_id IN (ua, ub) AND event_type = 'cpa_accepted';

  -- S: the source (phase AFTER only)
  IF fixed THEN
    PERFORM pg_temp.rec('S0 the source holds exactly one row, the D-366 value, distinct from the CPA version', pg_temp.q('SELECT count(*)::text || ''|'' || min(version_label) FROM public.agreement_version_current'), '1|' || s, '');
    PERFORM pg_temp.rec('S0a the agreement version is not the CPA version', (s IS DISTINCT FROM (SELECT version_label FROM public.cpa_versions WHERE is_current))::text, 'true', '');
    r := pg_temp.try_as('postgres', NULL, '', NULL, 'INSERT INTO public.agreement_version_current (singleton, version_label) VALUES (false, ''v3-2099-01'')');
    PERFORM pg_temp.rec('S1 a second row is impossible (CHECK singleton, 23514)', left(r, 15), 'REJECTED 23514 ', r);
    r := pg_temp.try_as('postgres', NULL, '', NULL, 'INSERT INTO public.agreement_version_current (singleton, version_label) VALUES (true, ''v3-2099-01'')');
    PERFORM pg_temp.rec('S1a a second row is impossible (primary key, 23505)', left(r, 15), 'REJECTED 23505 ', r);
    r := pg_temp.try_as('postgres', NULL, '', NULL, 'UPDATE public.agreement_version_current SET version_label = ''2026-10''');
    PERFORM pg_temp.rec('S1b a malformed label is refused (CHECK, 23514)', left(r, 15), 'REJECTED 23514 ', r);
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, 'SELECT version_label FROM public.agreement_version_current');
    PERFORM pg_temp.rec('S2 authenticated cannot read the source (42501)', left(r, 17), 'REJECTED 42501 pe', r);
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, 'UPDATE public.agreement_version_current SET version_label = ''v9-2099-01''');
    PERFORM pg_temp.rec('S2a authenticated cannot UPDATE the source (42501)', left(r, 17), 'REJECTED 42501 pe', r);
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, 'DELETE FROM public.agreement_version_current');
    PERFORM pg_temp.rec('S2b authenticated cannot DELETE the source (42501)', left(r, 17), 'REJECTED 42501 pe', r);
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, 'INSERT INTO public.agreement_version_current (singleton, version_label) VALUES (true, ''v9-2099-01'')');
    PERFORM pg_temp.rec('S2c authenticated cannot INSERT into the source (42501)', left(r, 17), 'REJECTED 42501 pe', r);
    r := pg_temp.try_as('anon', NULL, '', h1, 'SELECT version_label FROM public.agreement_version_current');
    PERFORM pg_temp.rec('S2d anon cannot read the source (42501)', left(r, 17), 'REJECTED 42501 pe', r);
    r := pg_temp.try_as('service_role', NULL, '', h1, 'UPDATE public.agreement_version_current SET version_label = ''v9-2099-01''');
    PERFORM pg_temp.rec('S2e service_role cannot UPDATE the source (grants revoked, 42501)', left(r, 17), 'REJECTED 42501 pe', r);
    PERFORM pg_temp.rec('S2f after every refused write the source is intact', pg_temp.q('SELECT version_label FROM public.agreement_version_current'), s, '');
  END IF;

  -- G: grants on accept_cpa are exactly as gh-2995 left them, in both phases
  PERFORM pg_temp.rec('G1 accept_cpa EXECUTE: authenticated yes, anon no, PUBLIC no', has_function_privilege('authenticated', 'public.accept_cpa(text)', 'EXECUTE')::text || '/' || has_function_privilege('anon', 'public.accept_cpa(text)', 'EXECUTE')::text || '/' || coalesce((SELECT bool_or(a.grantee = 0) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = 'public.accept_cpa(text)'::regprocedure), false)::text, 'true/false/false', '');
  PERFORM pg_temp.rec('G2 accept_cpa is SECURITY DEFINER with the pinned search_path', (SELECT prosecdef::text || '|' || coalesce(proconfig::text, '') FROM pg_proc WHERE oid = 'public.accept_cpa(text)'::regprocedure), 'true|{"search_path=public, pg_temp"}', '');

  -- D: a direct client write of agreement_version is refused (pinned by the freeze trigger), in both phases
  UPDATE public.contractors SET agreement_version = s WHERE id = b;
  r := pg_temp.try_as('authenticated', ub, 'b@otterquote-internal.test', h1, format('UPDATE public.contractors SET agreement_version=%L WHERE user_id=%L', 'v9-anything', ub));
  PERFORM pg_temp.rec('D1 direct client UPDATE of agreement_version is refused (value unchanged)', pg_temp.q(format('SELECT agreement_version FROM public.contractors WHERE id=%L', b)), s, r);
  r := pg_temp.try_as('authenticated', ub, 'b@otterquote-internal.test', h1, format('UPDATE public.contractors SET agreement_version=NULL WHERE user_id=%L', ub));
  PERFORM pg_temp.rec('D1a direct client UPDATE of agreement_version to NULL is refused', pg_temp.q(format('SELECT agreement_version FROM public.contractors WHERE id=%L', b)), s, r);
  UPDATE public.contractors SET agreement_version = NULL WHERE id = b;
  r := pg_temp.try_as('authenticated', ub, 'b@otterquote-internal.test', h1, format('UPDATE public.contractors SET agreement_version=%L WHERE user_id=%L', 'v9-anything', ub));
  PERFORM pg_temp.rec('D1b direct client UPDATE cannot stamp a NULL either', pg_temp.q(format('SELECT agreement_version FROM public.contractors WHERE id=%L', b)), '<null>', r);

  -- D-366 separation: the agreement version cannot be passed as the CPA version
  r := pg_temp.try_as('authenticated', ub, 'b@otterquote-internal.test', h1, format('SELECT public.accept_cpa(%L)', s));
  PERFORM pg_temp.rec('D2 accept_cpa refuses the agreement version as p_version (22023)', left(r, 17), 'REJECTED 22023 in', r);
  PERFORM pg_temp.rec('D2a that refused call wrote nothing', pg_temp.nacc(b), '0', '');

  -- P: the closes-on. Pre-approval onboarding: the user inserts own contractors row (naming no acceptance column; client tries to plant
  -- v9-anything in agreement_version), then calls accept_cpa(). Fresh auth user C.
  INSERT INTO auth.users (id, email) VALUES (cu, 'c@otterquote-internal.test');
  r := pg_temp.try_as('authenticated', cu, 'c@otterquote-internal.test', h1,
    format('INSERT INTO public.contractors (id, user_id, company_name, contact_name, email, agreement_version) VALUES (%L, %L, ''CTO Proof Co'', ''CTO Proof Contact'', ''c@otterquote-internal.test'', ''v9-anything'')', cc, cu));
  PERFORM pg_temp.rec('P0 the onboarding INSERT succeeds and the planted agreement_version is discarded (NULL)', left(r, 2) || '|' || pg_temp.q(format('SELECT agreement_version FROM public.contractors WHERE id=%L', cc)), 'ok|<null>', r);
  r := pg_temp.try_as('authenticated', cu, 'c@otterquote-internal.test', h1, format('SELECT public.accept_cpa(%L)', v));
  PERFORM pg_temp.rec('P1a pre-approval accept_cpa call succeeds', left(r, 2), 'ok', r);
  PERFORM pg_temp.rec('[expect-differs] P1 CLOSES-ON: agreement_version equals the server current agreement version (NEGATIVE CONTROL: NULL under the gh-2995 function)',
    pg_temp.q(format('SELECT agreement_version FROM public.contractors WHERE id=%L', cc)), CASE WHEN fixed THEN s ELSE '<null>' END, '');
  PERFORM pg_temp.rec('P2 CLOSES-ON: cpa_version unchanged by the stamp (still the CPA version) and cpa_accepted_at set',
    pg_temp.q(format('SELECT cpa_version || (cpa_accepted_at IS NOT NULL)::text FROM public.contractors WHERE id=%L', cc)), v || 'true', '');
  PERFORM pg_temp.rec('P2a D-366: the two stored values are distinct', pg_temp.q(format('SELECT (cpa_version IS DISTINCT FROM agreement_version)::text FROM public.contractors WHERE id=%L', cc)), 'true', '');
  r := pg_temp.try_as('authenticated', cu, 'c@otterquote-internal.test', h1, format('UPDATE public.contractors SET agreement_version=%L, cpa_version=%L WHERE user_id=%L', 'v9-anything', 'v9-anything', cu));
  PERFORM pg_temp.rec('P3 CLOSES-ON: a direct client UPDATE of agreement_version (and cpa_version) after onboarding is refused',
    pg_temp.q(format('SELECT cpa_version || ''|'' || coalesce(agreement_version, ''<null>'') FROM public.contractors WHERE id=%L', cc)), v || '|' || CASE WHEN fixed THEN s ELSE '<null>' END, r);
  PERFORM pg_temp.rec('P4 the acceptance record and activity_log row are still written (gh-2995 behaviour unchanged)',
    pg_temp.q(format('SELECT (SELECT count(*) FROM public.contractor_cpa_acceptances WHERE contractor_id=%L AND kind=''first'' AND accepted_ip=''203.0.113.7'')::text || (SELECT count(*) FROM public.activity_log WHERE user_id=%L AND event_type=''cpa_accepted'')::text', cc, cu)), '11', '');

  IF fixed THEN
    -- R: server-held, not hard-coded; re-acceptance semantics
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, format('SELECT public.accept_cpa(%L)', v));
    PERFORM pg_temp.rec('R1 contractor A first acceptance stamps the server value', left(r, 2) || '|' || pg_temp.q(format('SELECT agreement_version FROM public.contractors WHERE id=%L', a)), 'ok|' || s, r);
    UPDATE public.agreement_version_current SET version_label = 'v3-2099-01';   -- owner bump (a Tier 3B migration in production)
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h2, format('SELECT public.accept_cpa(%L)', v));
    PERFORM pg_temp.rec('R2 a re-acceptance does NOT move an existing agreement_version', left(r, 2) || '|' || pg_temp.q(format('SELECT agreement_version FROM public.contractors WHERE id=%L', a)), 'ok|' || s, r);
    r := pg_temp.try_as('authenticated', ub, 'b@otterquote-internal.test', h1, format('SELECT public.accept_cpa(%L)', v));
    PERFORM pg_temp.rec('R3 after a server-side bump a NEW contractor is stamped with the new server value (nothing client-side or hard-coded)', left(r, 2) || '|' || pg_temp.q(format('SELECT agreement_version FROM public.contractors WHERE id=%L', b)), 'ok|v3-2099-01', r);
    UPDATE public.contractors SET agreement_version = NULL WHERE id = a;
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h2, format('SELECT public.accept_cpa(%L)', v));
    PERFORM pg_temp.rec('R4 a re-acceptance fills a NULL agreement_version with the current server value', left(r, 2) || '|' || pg_temp.q(format('SELECT agreement_version FROM public.contractors WHERE id=%L', a)), 'ok|v3-2099-01', r);
    PERFORM pg_temp.rec('R5 cpa_version is still the CPA version on A and B after all of it', pg_temp.q(format('SELECT string_agg(cpa_version, ''|'' ORDER BY id) FROM public.contractors WHERE id IN (%L, %L)', a, b)), v || '|' || v, '');
    UPDATE public.agreement_version_current SET version_label = s;

    -- M: a missing source row refuses the call and writes nothing (no NULL stamp, no half-write)
    DELETE FROM public.agreement_version_current;
    UPDATE public.contractors SET agreement_accepted_at = NULL, agreement_version = NULL, cpa_accepted_at = NULL WHERE id = b;
    r := pg_temp.try_as('authenticated', ub, 'b@otterquote-internal.test', h1, format('SELECT public.accept_cpa(%L)', v));
    PERFORM pg_temp.rec('M1 a missing source row refuses accept_cpa (55000 agreement_version_unset)', left(r, 38), 'REJECTED 55000 agreement_version_unset', r);
    PERFORM pg_temp.rec('M2 the refused call wrote no acceptance row (B keeps its earlier one) and no stamp', pg_temp.nacc(b) || '|' || pg_temp.q(format('SELECT coalesce(agreement_version, ''<null>'') FROM public.contractors WHERE id=%L', b)), '1|<null>', '');
    INSERT INTO public.agreement_version_current (singleton, version_label) VALUES (true, s);

    -- C: callers need no change: signature and return shape unchanged
    PERFORM pg_temp.rec('C1 accept_cpa signature and return type unchanged', (SELECT pg_get_function_identity_arguments(oid) || '|' || prorettype::regtype::text FROM pg_proc WHERE oid = 'public.accept_cpa(text)'::regprocedure), 'p_version text|jsonb', '');
    PERFORM pg_temp.rec('C2 the freeze trigger function and record_cpa_ip still exist (untouched)', (to_regprocedure('public.contractors_freeze_privileged_columns()') IS NOT NULL AND to_regprocedure('public.record_cpa_ip(uuid)') IS NOT NULL)::text, 'true', '');
  END IF;
END $f$;

SELECT pg_temp.run();
-- Result table (phase label comes from the runner, which echoes has_src first)
SELECT 'fixed=' || pg_temp.has_src()::text AS phase;
SELECT n, label, got, expected, ok, detail FROM proof_r ORDER BY n;
SELECT 'FAILING=' || count(*) FILTER (WHERE NOT ok) || ' of ' || count(*) AS summary FROM proof_r;
ROLLBACK;
