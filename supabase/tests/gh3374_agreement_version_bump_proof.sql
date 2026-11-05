-- gh-3374 proof: bumping public.agreement_version_current changes what the NEXT first acceptance is stamped with, and nothing else.
-- ONE transaction that ends in ROLLBACK; nothing commits. Base = gh3073_throwaway_schema.sql (gh-2995 + gh-3073 forward applied by the runner).
-- The forward and rollback files are executed from their real paths (psql backtick-cat into a string, run through pg_temp.try_as), so the proof exercises the exact bytes.
-- NEGATIVE CONTROL: step A shows TODAY'S behaviour (before the bump) on the same fixture: a first acceptance is stamped v2-2026-10 (the label of the text without the new 6.4 sentence).
-- Usage: PGHOST=... PGUSER=postgres bash supabase/tests/gh3374_agreement_version_bump_proof_run.sh
\set ON_ERROR_STOP on
\set fwd `cat supabase/migrations_drafts/gh3374_agreement_version_bump.sql`
\set rb `cat supabase/migrations_rollbacks/gh3374_agreement_version_bump_rollback.sql`
BEGIN;
CREATE TEMP TABLE proof_r (n serial PRIMARY KEY, label text, got text, expected text, ok boolean, detail text);
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
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, '<null>'); EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE; END $f$;
-- onboard: fresh auth user inserts own contractors row (planting a forged agreement_version), then calls accept_cpa('v1-2026-04')
CREATE FUNCTION pg_temp.onboard(p_u uuid, p_c uuid, p_mail text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE h text := '{"x-forwarded-for":"203.0.113.7","user-agent":"UA-proof/1.0"}'; r text;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (p_u, p_mail);
  r := pg_temp.try_as('authenticated', p_u, p_mail, h, format('INSERT INTO public.contractors (id, user_id, company_name, contact_name, email, agreement_version) VALUES (%L, %L, ''CTO Proof Co'', ''CTO Proof Contact'', %L, ''v9-forged'')', p_c, p_u, p_mail));
  IF left(r, 2) <> 'ok' THEN RETURN 'INSERT ' || r; END IF;
  RETURN pg_temp.try_as('authenticated', p_u, p_mail, h, 'SELECT public.accept_cpa(''v1-2026-04'')');
END $f$;
CREATE FUNCTION pg_temp.av(p_c uuid) RETURNS text LANGUAGE sql AS
  $f$ SELECT coalesce(agreement_version, '<null>') || '|' || cpa_version FROM public.contractors WHERE id = p_c $f$;

SELECT pg_temp.rec('A0 start: source holds exactly the old label', pg_temp.q('SELECT count(*)::text || ''|'' || min(version_label) FROM public.agreement_version_current'), '1|v2-2026-10', '');
SELECT pg_temp.rec('A1 NEGATIVE CONTROL (today): X onboards before the bump and is stamped v2-2026-10 (text without the new sentence); forged value discarded',
  pg_temp.onboard('dddddddd-1111-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000001', 'x@otterquote-internal.test') || ' / ' || pg_temp.av('dddddddd-0000-4000-8000-000000000001'),
  'ok rows=1 / v2-2026-10|v1-2026-04', '');

-- the bump, from its real file
SELECT pg_temp.rec('B0 the forward file runs clean as the migration owner', pg_temp.try_as('postgres', NULL, '', NULL, :'fwd'), 'ok rows=0', '');
SELECT pg_temp.rec('B1 the source holds exactly one row and it is the new label', pg_temp.q('SELECT count(*)::text || ''|'' || min(version_label) FROM public.agreement_version_current'), '1|v3-2026-11', '');
SELECT pg_temp.rec('B1a new label passes the table CHECK and differs from the CPA version', pg_temp.q('SELECT (version_label ~ ''^v[0-9]+-[0-9]{4}-[0-9]{2}$'' AND version_label <> (SELECT version_label FROM public.cpa_versions WHERE is_current))::text FROM public.agreement_version_current'), 'true', '');
SELECT pg_temp.rec('B2 CLOSES-ON: Y onboards after the bump and is stamped v3-2026-11; cpa_version unchanged v1-2026-04; forged value discarded',
  pg_temp.onboard('dddddddd-1111-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000002', 'y@otterquote-internal.test') || ' / ' || pg_temp.av('dddddddd-0000-4000-8000-000000000002'),
  'ok rows=1 / v3-2026-11|v1-2026-04', '');
SELECT pg_temp.rec('B3 X (stamped before the bump) keeps v2-2026-10: no backfill', pg_temp.av('dddddddd-0000-4000-8000-000000000001'), 'v2-2026-10|v1-2026-04', '');
SELECT pg_temp.rec('B3a X calls accept_cpa again (re-acceptance): value is not moved to v3-2026-11',
  pg_temp.try_as('authenticated', 'dddddddd-1111-4000-8000-000000000001', 'x@otterquote-internal.test', '{"user-agent":"UA-2"}', 'SELECT public.accept_cpa(''v1-2026-04'')') || ' / ' || pg_temp.av('dddddddd-0000-4000-8000-000000000001'),
  'ok rows=1 / v2-2026-10|v1-2026-04', '');
SELECT pg_temp.rec('B4 a direct client UPDATE of agreement_version stays pinned (Y keeps v3-2026-11)',
  pg_temp.try_as('authenticated', 'dddddddd-1111-4000-8000-000000000002', 'y@otterquote-internal.test', '{}', 'UPDATE public.contractors SET agreement_version = ''v9-forged'' WHERE id = ''dddddddd-0000-4000-8000-000000000002''') || ' / ' || pg_temp.av('dddddddd-0000-4000-8000-000000000002'),
  'ok rows=1 / v3-2026-11|v1-2026-04', '');
SELECT pg_temp.rec('B5 authenticated cannot change the source (42501) and it is intact',
  left(pg_temp.try_as('authenticated', 'dddddddd-1111-4000-8000-000000000002', 'y@otterquote-internal.test', '{}', 'UPDATE public.agreement_version_current SET version_label = ''v9-2099-01'''), 17) || ' / ' || pg_temp.q('SELECT version_label FROM public.agreement_version_current'),
  'REJECTED 42501 pe / v3-2026-11', '');
SELECT pg_temp.rec('B6 the forward file is a no-op when re-run', pg_temp.try_as('postgres', NULL, '', NULL, :'fwd') || ' / ' || pg_temp.q('SELECT version_label FROM public.agreement_version_current'), 'ok rows=0 / v3-2026-11', '');

-- guard: an unexpected starting label is refused
UPDATE public.agreement_version_current SET version_label = 'v9-2099-01';
SELECT pg_temp.rec('C1 GUARD: forward refuses (55000) when the row holds an unexpected label, and changes nothing',
  left(pg_temp.try_as('postgres', NULL, '', NULL, :'fwd'), 17) || ' / ' || pg_temp.q('SELECT version_label FROM public.agreement_version_current'), 'REJECTED 55000 gh / v9-2099-01', '');
SELECT pg_temp.rec('C2 GUARD: rollback refuses (55000) on the same unexpected label', left(pg_temp.try_as('postgres', NULL, '', NULL, :'rb'), 17), 'REJECTED 55000 gh', '');
UPDATE public.agreement_version_current SET version_label = 'v3-2026-11';
DELETE FROM public.agreement_version_current;
SELECT pg_temp.rec('C3 GUARD: forward refuses (55000) when the row is missing', left(pg_temp.try_as('postgres', NULL, '', NULL, :'fwd'), 17), 'REJECTED 55000 gh', '');
INSERT INTO public.agreement_version_current (singleton, version_label) VALUES (true, 'v3-2026-11');

-- rollback from its real file
SELECT pg_temp.rec('D0 the rollback file runs clean and restores the old label', pg_temp.try_as('postgres', NULL, '', NULL, :'rb') || ' / ' || pg_temp.q('SELECT version_label FROM public.agreement_version_current'), 'ok rows=0 / v2-2026-10', '');
SELECT pg_temp.rec('D1 Z onboards after the rollback and is stamped v2-2026-10 again',
  pg_temp.onboard('dddddddd-1111-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000003', 'z@otterquote-internal.test') || ' / ' || pg_temp.av('dddddddd-0000-4000-8000-000000000003'),
  'ok rows=1 / v2-2026-10|v1-2026-04', '');
SELECT pg_temp.rec('D2 Y, stamped v3-2026-11 while the bump was live, keeps it (rollback does not rewrite records)', pg_temp.av('dddddddd-0000-4000-8000-000000000002'), 'v3-2026-11|v1-2026-04', '');
SELECT pg_temp.rec('D3 the rollback file is a no-op when re-run', pg_temp.try_as('postgres', NULL, '', NULL, :'rb') || ' / ' || pg_temp.q('SELECT version_label FROM public.agreement_version_current'), 'ok rows=0 / v2-2026-10', '');
SELECT pg_temp.rec('E0 forward again after the rollback', pg_temp.try_as('postgres', NULL, '', NULL, :'fwd') || ' / ' || pg_temp.q('SELECT version_label FROM public.agreement_version_current'), 'ok rows=0 / v3-2026-11', '');

SELECT 'FAILING=' || count(*) FILTER (WHERE NOT ok) || ' of ' || count(*) FROM proof_r;
SELECT n || ' | ' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || ' | ' || label || ' | got=' || got || CASE WHEN ok THEN '' ELSE ' | expected=' || expected || ' | ' || detail END FROM proof_r ORDER BY n;
ROLLBACK;
