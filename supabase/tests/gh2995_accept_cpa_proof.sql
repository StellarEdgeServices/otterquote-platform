-- gh-2995 proof: accept_cpa() writes append-only, server-stamped, atomic acceptance records.
-- ONE transaction that ends in ROLLBACK; nothing commits. The last statement before ROLLBACK is the result table; every row's ok must be true.
-- Rows prefixed [expect-differs] are the controls where TODAY (forward NOT applied) and AFTER (forward applied) are meant to differ.
-- Usage:
--   throwaway Postgres: bash supabase/tests/gh2995_accept_cpa_proof_run.sh   (TODAY -> AFTER -> ROLLBACK phases)
--   production (read the pre-flight first; is_test rows only): the forward SQL is spliced INSIDE this transaction, i.e. run
--     BEGIN; <forward file>; <this file minus its BEGIN/ROLLBACK lines> ROLLBACK;   in one statement batch, then confirm 0 failing rows.
--   The two contractors A and B are the first two is_test rows by id (production) or the two seeded rows (throwaway).
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

CREATE FUNCTION pg_temp.has_fn() RETURNS boolean LANGUAGE sql AS $f$ SELECT to_regprocedure('public.accept_cpa(text)') IS NOT NULL $f$;
CREATE FUNCTION pg_temp.has_tbl() RETURNS boolean LANGUAGE sql AS $f$ SELECT to_regclass('public.contractor_cpa_acceptances') IS NOT NULL $f$;
CREATE FUNCTION pg_temp.nacc(p_cid uuid) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT pg_temp.has_tbl() THEN RETURN 'no-table'; END IF;
  RETURN (SELECT count(*)::text FROM public.contractor_cpa_acceptances WHERE contractor_id = p_cid);
END $f$;
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, '<null>'); EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE; END $f$;

CREATE FUNCTION pg_temp.run() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  a uuid; ua uuid; b uuid; ub uuid; r text; v text := 'v1-2026-04';
  h1 text := '{"x-forwarded-for":"203.0.113.7, 10.0.0.1","user-agent":"UA-first/1.0"}';
  h2 text := '{"x-forwarded-for":"198.51.100.9","user-agent":"UA-second/2.0"}';
  c_own text; c_adm text; first_id text; fixed boolean := pg_temp.has_fn();
BEGIN
  SELECT c.a, c.ua, c.b, c.ub INTO a, ua, b, ub FROM proof_ctx c;
  IF a IS NULL OR b IS NULL THEN RAISE EXCEPTION 'proof needs two is_test contractors'; END IF;
  -- Start both from a NEW contractor: no acceptance yet.
  UPDATE public.contractors SET agreement_accepted_at = NULL, agreement_version = 'v2-2026-10', cpa_version = 'v1-2026-04', cpa_accepted_at = NULL,
         needs_cpa_reattestation = false, ic_24511_attestation = NULL WHERE id IN (a, b);
  DELETE FROM public.activity_log WHERE user_id IN (ua, ub) AND event_type = 'cpa_accepted';

  -- D (F1 negative control): a contractor's own direct UPDATE of each acceptance column. TODAY the change lands; AFTER it is pinned.
  -- Baseline row B: accepted 2019-01-01, cpa v1-2026-04, agreement v2-2026-10, flag true. Each attempt is a separate statement as authenticated.
  UPDATE public.contractors SET agreement_accepted_at='2019-01-01', cpa_accepted_at='2019-01-01', cpa_version='v1-2026-04', agreement_version='v2-2026-10', needs_cpa_reattestation=true WHERE id = b;
  r := pg_temp.try_as('authenticated', ub, 'b@otterquote-internal.test', h1, format('UPDATE public.contractors SET agreement_accepted_at=%L WHERE user_id=%L', '2020-01-01', ub));
  PERFORM pg_temp.rec('[expect-differs] D1 direct UPDATE agreement_accepted_at', pg_temp.q(format('SELECT agreement_accepted_at::date::text FROM public.contractors WHERE id=%L', b)), CASE WHEN fixed THEN '2019-01-01' ELSE '2020-01-01' END, r);
  r := pg_temp.try_as('authenticated', ub, 'b@otterquote-internal.test', h1, format('UPDATE public.contractors SET cpa_accepted_at=%L WHERE user_id=%L', '2020-01-01', ub));
  PERFORM pg_temp.rec('[expect-differs] D2 direct UPDATE cpa_accepted_at', pg_temp.q(format('SELECT cpa_accepted_at::date::text FROM public.contractors WHERE id=%L', b)), CASE WHEN fixed THEN '2019-01-01' ELSE '2020-01-01' END, r);
  r := pg_temp.try_as('authenticated', ub, 'b@otterquote-internal.test', h1, format('UPDATE public.contractors SET cpa_version=%L WHERE user_id=%L', 'v9-anything', ub));
  PERFORM pg_temp.rec('[expect-differs] D3 direct UPDATE cpa_version', pg_temp.q(format('SELECT cpa_version FROM public.contractors WHERE id=%L', b)), CASE WHEN fixed THEN 'v1-2026-04' ELSE 'v9-anything' END, r);
  r := pg_temp.try_as('authenticated', ub, 'b@otterquote-internal.test', h1, format('UPDATE public.contractors SET agreement_version=%L WHERE user_id=%L', 'v9-anything', ub));
  PERFORM pg_temp.rec('[expect-differs] D4 direct UPDATE agreement_version', pg_temp.q(format('SELECT agreement_version FROM public.contractors WHERE id=%L', b)), CASE WHEN fixed THEN 'v2-2026-10' ELSE 'v9-anything' END, r);
  UPDATE public.contractors SET cpa_version='v1-2026-04' WHERE id = b;
  r := pg_temp.try_as('authenticated', ub, 'b@otterquote-internal.test', h1, format('UPDATE public.contractors SET needs_cpa_reattestation=false, cpa_version=%L WHERE user_id=%L', v, ub));
  PERFORM pg_temp.rec('[expect-differs] D5 direct clear of needs_cpa_reattestation with the current version', pg_temp.q(format('SELECT needs_cpa_reattestation::text FROM public.contractors WHERE id=%L', b)), CASE WHEN fixed THEN 'true' ELSE 'false' END, r);
  UPDATE public.contractors SET agreement_accepted_at = NULL, agreement_version = 'v2-2026-10', cpa_version = 'v1-2026-04', cpa_accepted_at = NULL, needs_cpa_reattestation = false WHERE id = b;

  -- L: legacy path (record_cpa_ip) is unchanged in both phases and shows the defect: first IP kept only under cpa_reaccept, overwritten by the next call.
  r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, format('SELECT public.record_cpa_ip(%L)', a));
  PERFORM pg_temp.rec('L1 legacy record_cpa_ip first call stores IP only under cpa_reaccept', pg_temp.q(format('SELECT ic_24511_attestation->''cpa_reaccept''->>''accepted_ip'' FROM public.contractors WHERE id=%L', a)), '203.0.113.7', r);
  r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h2, format('SELECT public.record_cpa_ip(%L)', a));
  PERFORM pg_temp.rec('L2 NEGATIVE CONTROL legacy second call OVERWRITES the first IP', pg_temp.q(format('SELECT ic_24511_attestation->''cpa_reaccept''->>''accepted_ip'' FROM public.contractors WHERE id=%L', a)), '198.51.100.9', r);
  UPDATE public.contractors SET ic_24511_attestation = NULL WHERE id = a;

  -- C1 first acceptance (new is_test contractor)
  r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, format('SELECT public.accept_cpa(%L)', v));
  PERFORM pg_temp.rec('[expect-differs] C1 first accept_cpa call', left(r, 2), CASE WHEN fixed THEN 'ok' ELSE 'RE' END, r);
  PERFORM pg_temp.rec('[expect-differs] C1a one acceptance record', pg_temp.nacc(a), CASE WHEN fixed THEN '1' ELSE 'no-table' END, '');
  IF fixed THEN
    first_id := pg_temp.q(format('SELECT id::text FROM public.contractor_cpa_acceptances WHERE contractor_id=%L ORDER BY accepted_at, id LIMIT 1', a));
    PERFORM pg_temp.rec('C1b record IP is the server-read first IP', pg_temp.q(format('SELECT accepted_ip FROM public.contractor_cpa_acceptances WHERE id=%L', first_id)), '203.0.113.7', '');
    PERFORM pg_temp.rec('C1c record user agent', pg_temp.q(format('SELECT accepted_ua FROM public.contractor_cpa_acceptances WHERE id=%L', first_id)), 'UA-first/1.0', '');
    PERFORM pg_temp.rec('C1d record agreement version id is v1-2026-04 (not a date)', pg_temp.q(format('SELECT agreement_version FROM public.contractor_cpa_acceptances WHERE id=%L', first_id)), v, '');
    PERFORM pg_temp.rec('C1e record kind and server timestamp present', pg_temp.q(format('SELECT kind || (accepted_at IS NOT NULL)::text FROM public.contractor_cpa_acceptances WHERE id=%L', first_id)), 'firsttrue', '');
    PERFORM pg_temp.rec('C1f F3/D-366: accept_cpa leaves contractors.agreement_version untouched (stays v2-2026-10)', pg_temp.q(format('SELECT agreement_version FROM public.contractors WHERE id=%L', a)), 'v2-2026-10', '');
    PERFORM pg_temp.rec('C1g contractors cpa_version, flag and agreement_accepted_at set', pg_temp.q(format('SELECT cpa_version || needs_cpa_reattestation::text || (agreement_accepted_at IS NOT NULL AND cpa_accepted_at IS NOT NULL)::text FROM public.contractors WHERE id=%L', a)), v || 'falsetrue', '');
    PERFORM pg_temp.rec('C1h activity_log row: exact existing title, is_test, metadata carries IP, UA, version', pg_temp.q(format('SELECT title || ''|'' || is_test::text || ''|'' || (metadata->>''accepted_ip'') || ''|'' || (metadata->>''accepted_ua'') || ''|'' || (metadata->>''agreement_version'') || ''|'' || (metadata->>''acceptance_id'') FROM public.activity_log WHERE user_id=%L AND event_type=''cpa_accepted''', ua)), 'Accepted Contractor Partner Agreement (v1-2026-04)|true|203.0.113.7|UA-first/1.0|v1-2026-04|' || first_id, '');
    PERFORM pg_temp.rec('C1i acceptance row is_test stamped from contractors.is_test', pg_temp.q(format('SELECT is_test::text FROM public.contractor_cpa_acceptances WHERE id=%L', first_id)), 'true', '');

    -- C2 re-acceptance: second distinct record, first record unchanged
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h2, format('SELECT public.accept_cpa(%L)', v));
    PERFORM pg_temp.rec('C2 re-acceptance call', left(r, 2), 'ok', r);
    PERFORM pg_temp.rec('C2a two distinct durable records', pg_temp.q(format('SELECT count(DISTINCT id)::text FROM public.contractor_cpa_acceptances WHERE contractor_id=%L', a)), '2', '');
    PERFORM pg_temp.rec('C2b CLOSES-ON: first record IP unchanged after re-acceptance', pg_temp.q(format('SELECT accepted_ip FROM public.contractor_cpa_acceptances WHERE id=%L', first_id)), '203.0.113.7', '');
    PERFORM pg_temp.rec('C2c second record has its own IP, UA, version id and kind', pg_temp.q(format('SELECT accepted_ip || ''|'' || accepted_ua || ''|'' || agreement_version || ''|'' || kind FROM public.contractor_cpa_acceptances WHERE contractor_id=%L AND id <> %L', a, first_id)), '198.51.100.9|UA-second/2.0|v1-2026-04|reaccept', '');
    PERFORM pg_temp.rec('C2d re-acceptance activity_log title is the existing re-accept string', pg_temp.q(format('SELECT title FROM public.activity_log WHERE user_id=%L AND event_type=''cpa_accepted'' AND metadata->>''kind''=''reaccept''', ua)), 'Accepted updated Contractor Partner Agreement (v1-2026-04)', '');
    PERFORM pg_temp.rec('C2e agreement_accepted_at not moved by the re-acceptance', pg_temp.q(format('SELECT (agreement_accepted_at = (SELECT min(accepted_at) FROM public.contractor_cpa_acceptances WHERE contractor_id=%L))::text FROM public.contractors WHERE id=%L', a, a)), 'true', '');

    -- C3 version gate
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, format('SELECT public.accept_cpa(%L)', 'v9-2099-01'));
    PERFORM pg_temp.rec('C3 invented version refused 22023', left(r, 17), 'REJECTED 22023 in', r);
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, format('SELECT public.accept_cpa(%L)', '2026-10-23'));
    PERFORM pg_temp.rec('C3b a date string refused 22023', left(r, 17), 'REJECTED 22023 in', r);
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, 'SELECT public.accept_cpa(NULL)');
    PERFORM pg_temp.rec('C3c NULL version refused 22023', left(r, 17), 'REJECTED 22023 in', r);
    PERFORM pg_temp.rec('C3d refused calls wrote nothing', pg_temp.nacc(a), '2', '');

    -- C4 append-only
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, format('UPDATE public.contractor_cpa_acceptances SET accepted_ip=''9.9.9.9'' WHERE id=%L', first_id));
    PERFORM pg_temp.rec('C4a authenticated UPDATE refused 42501', left(r, 17), 'REJECTED 42501 pe', r);
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, format('DELETE FROM public.contractor_cpa_acceptances WHERE id=%L', first_id));
    PERFORM pg_temp.rec('C4b authenticated DELETE refused 42501', left(r, 17), 'REJECTED 42501 pe', r);
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, format('INSERT INTO public.contractor_cpa_acceptances (contractor_id,user_id,agreement_version,kind) VALUES (%L,%L,%L,''first'')', a, ua, v));
    PERFORM pg_temp.rec('C4c authenticated direct INSERT refused 42501', left(r, 17), 'REJECTED 42501 pe', r);
    r := pg_temp.try_as('postgres', NULL, '', NULL, format('UPDATE public.contractor_cpa_acceptances SET accepted_ip=''9.9.9.9'' WHERE id=%L', first_id));
    PERFORM pg_temp.rec('C4d owner UPDATE refused by trigger 42501 append-only', left(r, 26), 'REJECTED 42501 contractor_', r);
    r := pg_temp.try_as('postgres', NULL, '', NULL, format('DELETE FROM public.contractor_cpa_acceptances WHERE id=%L', first_id));
    PERFORM pg_temp.rec('C4e owner DELETE refused by trigger 42501 append-only', left(r, 26), 'REJECTED 42501 contractor_', r);
    r := pg_temp.try_as('postgres', NULL, '', NULL, 'TRUNCATE public.contractor_cpa_acceptances');
    PERFORM pg_temp.rec('C4f owner TRUNCATE refused by trigger 42501 append-only', left(r, 26), 'REJECTED 42501 contractor_', r);
    PERFORM pg_temp.rec('C4g after all refused writes the first record is intact', pg_temp.q(format('SELECT accepted_ip FROM public.contractor_cpa_acceptances WHERE id=%L', first_id)), '203.0.113.7', '');

    -- C5 access
    r := pg_temp.try_as('anon', NULL, '', h1, format('SELECT public.accept_cpa(%L)', v));
    PERFORM pg_temp.rec('C5a anon cannot execute accept_cpa (42501)', left(r, 17), 'REJECTED 42501 pe', r);
    r := pg_temp.try_as('authenticated', NULL, '', h1, format('SELECT public.accept_cpa(%L)', v));
    PERFORM pg_temp.rec('C5b authenticated without a user id refused 42501', left(r, 17), 'REJECTED 42501 No', r);
    r := pg_temp.try_as('authenticated', gen_random_uuid(), 'x@x.test', h1, format('SELECT public.accept_cpa(%L)', v));
    PERFORM pg_temp.rec('C5c authenticated user with no contractor row refused 42501', left(r, 17), 'REJECTED 42501 No', r);

    -- C6 cross-contractor: A's calls never touch B; B accepts only for B; B cannot read A's records
    PERFORM pg_temp.rec('C6a B has no record after A accepted twice', pg_temp.nacc(b), '0', '');
    r := pg_temp.try_as('authenticated', ub, 'b@otterquote-internal.test', h2, format('SELECT public.accept_cpa(%L)', v));
    PERFORM pg_temp.rec('C6b B accepts for B only', pg_temp.nacc(b) || '/' || pg_temp.nacc(a), '1/2', r);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated', 'email', 'b@otterquote-internal.test')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    c_own := (SELECT count(*)::text FROM public.contractor_cpa_acceptances) || '/' || (SELECT count(*)::text FROM public.contractor_cpa_acceptances WHERE contractor_id = a);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated', 'email', 'dustinstohler1@gmail.com')::text, true);
    c_adm := (SELECT count(*)::text FROM public.contractor_cpa_acceptances);
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.rec('C6c RLS: B sees 1 row, none of A''s', c_own, '1/0', '');
    PERFORM pg_temp.rec('C6d RLS: admin email sees all three rows', c_adm, '3', '');

    -- C7 atomicity: a failure in the third write rolls back the first two (negative control: a forced failure with no atomicity would leave rows)
    EXECUTE 'CREATE OR REPLACE FUNCTION public.proof_block_cpa_log() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN RAISE EXCEPTION ''proof forced activity_log failure'' USING ERRCODE = ''P0001''; END $t$';
    EXECUTE 'CREATE TRIGGER proof_block_cpa_log BEFORE INSERT ON public.activity_log FOR EACH ROW WHEN (NEW.event_type = ''cpa_accepted'') EXECUTE FUNCTION public.proof_block_cpa_log()';
    UPDATE public.contractors SET cpa_version = 'v0-before', cpa_accepted_at = NULL WHERE id = b;
    r := pg_temp.try_as('authenticated', ub, 'b@otterquote-internal.test', h1, format('SELECT public.accept_cpa(%L)', v));
    PERFORM pg_temp.rec('C7a forced third-write failure surfaces', left(r, 17), 'REJECTED P0001 pr', r);
    PERFORM pg_temp.rec('C7b the acceptance record rolled back with it', pg_temp.nacc(b), '1', '');
    PERFORM pg_temp.rec('C7c the contractors update rolled back with it', pg_temp.q(format('SELECT cpa_version FROM public.contractors WHERE id=%L', b)), 'v0-before', '');
    EXECUTE 'DROP TRIGGER proof_block_cpa_log ON public.activity_log';
    EXECUTE 'DROP FUNCTION public.proof_block_cpa_log()';

    -- E: first acceptance through the pre-approval sequence (user inserts own contractor row, then accept_cpa)
    INSERT INTO auth.users (id, email) VALUES ('cccccccc-1111-4000-8000-000000000003','c@otterquote-internal.test'), ('dddddddd-1111-4000-8000-000000000004','d@otterquote-internal.test');
    r := pg_temp.try_as('authenticated', 'cccccccc-1111-4000-8000-000000000003', 'c@otterquote-internal.test', h1,
      'INSERT INTO public.contractors (id, user_id, company_name, contact_name, email, agreement_accepted_at, cpa_accepted_at, cpa_version, agreement_version) VALUES (''cccccccc-0000-4000-8000-000000000003'', ''cccccccc-1111-4000-8000-000000000003'', ''CTO79 Proof Co'', ''CTO79 Proof Contact'', ''c@otterquote-internal.test'', now(), now(), ''v9-anything'', ''v9-anything'')');
    PERFORM pg_temp.rec('E0 contractor INSERT by the user succeeds', left(r, 2), 'ok', r);
    PERFORM pg_temp.rec('E0a INSERT cannot pre-accept: agreement_accepted_at, cpa_accepted_at, agreement_version NULL and cpa_version = column default v1-2026-04 (production: NOT NULL DEFAULT)', pg_temp.q('SELECT (agreement_accepted_at IS NULL AND cpa_accepted_at IS NULL AND cpa_version = ''v1-2026-04'' AND agreement_version IS NULL)::text FROM public.contractors WHERE id=''cccccccc-0000-4000-8000-000000000003'''), 'true', '');
    -- E0b: the exact init shape the pages use (contractor-pre-approval.html init, React pre-approval): no acceptance columns named.
    INSERT INTO auth.users (id, email) VALUES ('eeeeeeee-1111-4000-8000-000000000005','e@otterquote-internal.test');
    r := pg_temp.try_as('authenticated', 'eeeeeeee-1111-4000-8000-000000000005', 'e@otterquote-internal.test', h1,
      'INSERT INTO public.contractors (id, user_id, company_name, contact_name, email) VALUES (''eeeeeeee-0000-4000-8000-000000000005'', ''eeeeeeee-1111-4000-8000-000000000005'', ''CTO79 Proof Co'', ''CTO79 Proof Contact'', ''e@otterquote-internal.test'')');
    PERFORM pg_temp.rec('E0b authenticated client INSERT naming no acceptance column succeeds (production cpa_version NOT NULL; was 23502 on 08f66b14)', left(r, 2), 'ok', r);
    PERFORM pg_temp.rec('E0c that row holds cpa_version v1-2026-04, flag false, no acceptance timestamps', pg_temp.q('SELECT cpa_version || needs_cpa_reattestation::text || (agreement_accepted_at IS NULL AND cpa_accepted_at IS NULL AND agreement_version IS NULL)::text FROM public.contractors WHERE id=''eeeeeeee-0000-4000-8000-000000000005'''), 'v1-2026-04falsetrue', '');
    r := pg_temp.try_as('authenticated', 'cccccccc-1111-4000-8000-000000000003', 'c@otterquote-internal.test', h1, format('SELECT public.accept_cpa(%L)', v));
    PERFORM pg_temp.rec('E2 accept_cpa from the pre-approval sequence succeeds', left(r, 2), 'ok', r);
    PERFORM pg_temp.rec('E3 first acceptance via pre-approval produces ONE table row of kind first', pg_temp.q('SELECT count(*)::text || min(kind) FROM public.contractor_cpa_acceptances WHERE contractor_id=''cccccccc-0000-4000-8000-000000000003'''), '1first', '');
    PERFORM pg_temp.rec('E4 contractors row: server-stamped cpa_version and agreement_accepted_at set; agreement_version still NULL (never written)', pg_temp.q('SELECT cpa_version || (agreement_accepted_at IS NOT NULL)::text || (agreement_version IS NULL)::text FROM public.contractors WHERE id=''cccccccc-0000-4000-8000-000000000003'''), v || 'truetrue', '');

    -- F: deleting an auth user with an acceptance row succeeds and the evidence stays (no FK on user_id / contractor_id).
    INSERT INTO public.contractors (id, user_id, company_name, contact_name, email, is_test) VALUES ('dddddddd-0000-4000-8000-000000000004', 'dddddddd-1111-4000-8000-000000000004', 'CTO79 Proof Co', 'CTO79 Proof Contact', 'd@otterquote-internal.test', true);
    r := pg_temp.try_as('authenticated', 'dddddddd-1111-4000-8000-000000000004', 'd@otterquote-internal.test', h1, format('SELECT public.accept_cpa(%L)', v));
    -- NEGATIVE CONTROL: the rejected design (contractor_id REFERENCES contractors ON DELETE RESTRICT) blocks the same delete.
    CREATE TABLE public.proof_restrict_ctl (contractor_id uuid NOT NULL REFERENCES public.contractors(id) ON DELETE RESTRICT);
    INSERT INTO public.proof_restrict_ctl VALUES ('dddddddd-0000-4000-8000-000000000004');
    r := pg_temp.try_as('postgres', NULL, '', NULL, 'DELETE FROM auth.users WHERE id = ''dddddddd-1111-4000-8000-000000000004''');
    PERFORM pg_temp.rec('F0 NEGATIVE CONTROL: a RESTRICT FK to contractors makes the auth-user delete fail (23503)', left(r, 15), 'REJECTED 23503 ', r);
    DROP TABLE public.proof_restrict_ctl;
    r := pg_temp.try_as('postgres', NULL, '', NULL, 'DELETE FROM auth.users WHERE id = ''cccccccc-1111-4000-8000-000000000003''');
    PERFORM pg_temp.rec('F1 deleting the auth user that has an acceptance row succeeds', left(r, 2), 'ok', r);
    PERFORM pg_temp.rec('F2 the contractor row cascaded away', pg_temp.q('SELECT count(*)::text FROM public.contractors WHERE id=''cccccccc-0000-4000-8000-000000000003'''), '0', '');
    PERFORM pg_temp.rec('F3 the acceptance row REMAINS after the account is gone', pg_temp.q('SELECT count(*)::text FROM public.contractor_cpa_acceptances WHERE contractor_id=''cccccccc-0000-4000-8000-000000000003'' AND user_id=''cccccccc-1111-4000-8000-000000000003'''), '1', '');
    r := pg_temp.try_as('postgres', NULL, '', NULL, 'DELETE FROM auth.users WHERE id = ''dddddddd-1111-4000-8000-000000000004''');
    PERFORM pg_temp.rec('F4 with the control table gone the same delete succeeds and the row remains', left(r, 2) || pg_temp.q('SELECT count(*)::text FROM public.contractor_cpa_acceptances WHERE contractor_id=''dddddddd-0000-4000-8000-000000000004'''), 'ok1', r);

    -- C8 record_cpa_ip not dropped
    PERFORM pg_temp.rec('C8 record_cpa_ip() still exists (untouched)', (to_regprocedure('public.record_cpa_ip(uuid)') IS NOT NULL)::text, 'true', '');
  ELSE
    -- TODAY phase: the new objects are absent, the controls above (L1, L2) show today's defect.
    r := pg_temp.try_as('authenticated', ua, 'a@otterquote-internal.test', h1, format('SELECT public.accept_cpa(%L)', v));
    PERFORM pg_temp.rec('T1 accept_cpa does not exist today', left(r, 17), 'REJECTED 42883 fu', r);
  END IF;
END $f$;

SELECT pg_temp.run();
-- Result table (phase label comes from the runner, which echoes has_fn first)
SELECT 'fixed=' || pg_temp.has_fn()::text AS phase;
SELECT n, label, got, expected, ok, detail FROM proof_r ORDER BY n;
SELECT 'FAILING=' || count(*) FILTER (WHERE NOT ok) || ' of ' || count(*) AS summary FROM proof_r;
ROLLBACK;
