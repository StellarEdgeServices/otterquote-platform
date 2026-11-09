-- gh-3320 proof: after the forward file, anon and authenticated can no longer UPDATE or DELETE public.fee_acceptances (admin included); INSERT, SELECT and service_role are unchanged.
-- ONE transaction that ends in ROLLBACK; nothing commits. Phase-aware: the same file runs against BEFORE (today) and AFTER (forward applied) and the expectations differ only where intended.
-- NEGATIVE CONTROL = the BEFORE phase: on the unchanged table the owner's signed-in account CAN rewrite fee_text_displayed (U1) and the client roles hold UPDATE/DELETE (C1).
-- Rows prefixed [expect-differs] are the controls where BEFORE and AFTER are meant to differ. Usage: bash supabase/tests/gh3320_fee_acceptances_append_only_proof_run.sh
BEGIN;
CREATE TEMP TABLE proof_r (n serial PRIMARY KEY, label text, got text, expected text, ok boolean, detail text);
CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_email text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN 'ok rows=' || n;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 60);
  END;
END $f$;
CREATE FUNCTION pg_temp.rec(p_label text, p_got text, p_exp text, p_detail text) RETURNS void
LANGUAGE sql AS $f$ INSERT INTO proof_r(label,got,expected,ok,detail) VALUES (p_label,p_got,p_exp,p_got IS NOT DISTINCT FROM p_exp,p_detail) $f$;
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, '<null>'); EXCEPTION WHEN OTHERS THEN RETURN 'ERR ' || SQLSTATE; END $f$;

CREATE FUNCTION pg_temp.count_as(p_role text, p_sub uuid, p_email text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text, true);
  PERFORM set_config('role', p_role, true);
  SELECT count(*) INTO n FROM public.fee_acceptances;
  EXECUTE 'RESET ROLE';
  RETURN n::text;
END $f$;

CREATE FUNCTION pg_temp.run() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  fixed boolean := NOT has_table_privilege('authenticated', 'public.fee_acceptances', 'UPDATE');
  c1 uuid := 'eeeeeeee-0000-4000-8000-000000000001';  u1 uuid := 'eeeeeeee-1111-4000-8000-000000000001';
  c2 uuid := 'eeeeeeee-0000-4000-8000-000000000002';  u2 uuid := 'eeeeeeee-1111-4000-8000-000000000002';
  cl uuid := 'eeeeeeee-2222-4000-8000-000000000001';  bd uuid := 'eeeeeeee-3333-4000-8000-000000000001';
  f1 uuid := 'eeeeeeee-4444-4000-8000-000000000001';  f2 uuid := 'eeeeeeee-4444-4000-8000-000000000002';
  adm constant text := 'dustinstohler1@gmail.com';
  r text; orig constant text := 'Platform fee: $1,000.00 (5.00% of bid)';
  denied constant text := 'REJECTED 42501 permission denied for table fee_acceptances';
BEGIN
  INSERT INTO public.contractors (id, user_id) VALUES (c1, u1), (c2, u2);
  INSERT INTO public.claims (id) VALUES (cl);
  INSERT INTO public.quotes (id) VALUES (bd);
  INSERT INTO public.fee_acceptances (id, contractor_id, claim_id, bid_id, fee_pct, fee_basis, fee_amount, fee_text_displayed) VALUES
    (f1, c1, cl, bd, 5.00, 'bid_amount', 1000.00, orig), (f2, c2, cl, bd, 5.00, 'bid_amount', 1000.00, orig);

  -- C: the catalog, as the issue measured it
  PERFORM pg_temp.rec('[expect-differs] C1 client-role UPDATE/DELETE privileges (anon UPDATE,DELETE / authenticated UPDATE,DELETE)',
    has_table_privilege('anon', 'public.fee_acceptances', 'UPDATE')::text || ',' || has_table_privilege('anon', 'public.fee_acceptances', 'DELETE')::text || ' / ' ||
    has_table_privilege('authenticated', 'public.fee_acceptances', 'UPDATE')::text || ',' || has_table_privilege('authenticated', 'public.fee_acceptances', 'DELETE')::text,
    CASE WHEN fixed THEN 'false,false / false,false' ELSE 'true,false / true,true' END, '');
  PERFORM pg_temp.rec('C1a service_role keeps UPDATE and DELETE (e2e teardown, one-off purges); INSERT and SELECT stay for the client roles',
    has_table_privilege('service_role', 'public.fee_acceptances', 'UPDATE')::text || ',' || has_table_privilege('service_role', 'public.fee_acceptances', 'DELETE')::text || ' / ' ||
    has_table_privilege('authenticated', 'public.fee_acceptances', 'INSERT')::text || ',' || has_table_privilege('authenticated', 'public.fee_acceptances', 'SELECT')::text || ' / ' ||
    has_table_privilege('anon', 'public.fee_acceptances', 'INSERT')::text || ',' || has_table_privilege('anon', 'public.fee_acceptances', 'SELECT')::text,
    'true,true / true,true / true,true', '');
  PERFORM pg_temp.rec('[expect-differs] C2 policies on the table',
    (SELECT string_agg(policyname || '/' || cmd, '; ' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fee_acceptances'),
    CASE WHEN fixed THEN 'Admin can read all fee acceptances/SELECT; Contractors can insert own fee acceptances/INSERT; Contractors can read own fee acceptances/SELECT'
         ELSE 'Admin can read all fee acceptances/SELECT; Admin can update fee acceptances/UPDATE; Contractors can insert own fee acceptances/INSERT; Contractors can read own fee acceptances/SELECT' END, '');
  PERFORM pg_temp.rec('C3 RLS is enabled and not forced (unchanged)', (SELECT relrowsecurity::text || '/' || relforcerowsecurity::text FROM pg_class WHERE oid = 'public.fee_acceptances'::regclass), 'true/false', '');

  -- U: the attempts, as each role
  r := pg_temp.try_as('authenticated', gen_random_uuid(), adm, format('UPDATE public.fee_acceptances SET fee_text_displayed = %L WHERE id = %L', 'TAMPERED by admin account', f1));
  PERFORM pg_temp.rec('[expect-differs] U1 the owner''s signed-in account rewrites fee_text_displayed (the one path the policies allowed)', r, CASE WHEN fixed THEN denied ELSE 'ok rows=1' END, '');
  PERFORM pg_temp.rec('[expect-differs] U1a the evidence column after that attempt', (SELECT fee_text_displayed FROM public.fee_acceptances WHERE id = f1), CASE WHEN fixed THEN orig ELSE 'TAMPERED by admin account' END, '');
  UPDATE public.fee_acceptances SET fee_text_displayed = orig WHERE id = f1;   -- owner restores the fixture
  r := pg_temp.try_as('authenticated', gen_random_uuid(), adm, format('DELETE FROM public.fee_acceptances WHERE id = %L', f1));
  PERFORM pg_temp.rec('[expect-differs] U2 the owner''s account DELETE (no DELETE policy: 0 rows before, refused at the privilege layer after)', r, CASE WHEN fixed THEN denied ELSE 'ok rows=0' END, '');
  r := pg_temp.try_as('authenticated', u1, 'c1@example.test', format('UPDATE public.fee_acceptances SET fee_amount = 1 WHERE id = %L', f1));
  PERFORM pg_temp.rec('[expect-differs] U3 a contractor UPDATE of their own acceptance (RLS: 0 rows before, refused after)', r, CASE WHEN fixed THEN denied ELSE 'ok rows=0' END, '');
  r := pg_temp.try_as('authenticated', u1, 'c1@example.test', format('DELETE FROM public.fee_acceptances WHERE id = %L', f1));
  PERFORM pg_temp.rec('[expect-differs] U4 a contractor DELETE of their own acceptance', r, CASE WHEN fixed THEN denied ELSE 'ok rows=0' END, '');
  r := pg_temp.try_as('anon', NULL, '', format('UPDATE public.fee_acceptances SET fee_amount = 1 WHERE id = %L', f1));
  PERFORM pg_temp.rec('[expect-differs] U5 anon UPDATE', r, CASE WHEN fixed THEN denied ELSE 'ok rows=0' END, '');
  r := pg_temp.try_as('anon', NULL, '', format('DELETE FROM public.fee_acceptances WHERE id = %L', f1));
  PERFORM pg_temp.rec('U5a anon DELETE is refused in both phases (gh-1529)', r, denied, '');
  PERFORM pg_temp.rec('U6 after every client attempt both rows are intact', (SELECT count(*)::text || '|' || min(fee_text_displayed) || '|' || max(fee_amount)::text FROM public.fee_acceptances), '2|' || orig || '|1000.00', '');

  -- K: what must keep working
  r := pg_temp.try_as('authenticated', u1, 'c1@example.test', format('INSERT INTO public.fee_acceptances (contractor_id, claim_id, bid_id, fee_pct, fee_basis, fee_amount, fee_text_displayed) VALUES (%L, %L, %L, 5, ''bid_amount'', 50, ''new'')', c1, cl, bd));
  PERFORM pg_temp.rec('K1 a contractor can still INSERT their own acceptance (bid submission)', r, 'ok rows=1', '');
  r := pg_temp.try_as('authenticated', u1, 'c1@example.test', format('INSERT INTO public.fee_acceptances (contractor_id, claim_id, bid_id, fee_pct, fee_basis, fee_amount, fee_text_displayed) VALUES (%L, %L, %L, 5, ''bid_amount'', 50, ''forged'')', c2, cl, bd));
  PERFORM pg_temp.rec('K1a a contractor still cannot INSERT for another contractor (RLS 42501)', left(r, 15), 'REJECTED 42501 ', r);
  PERFORM pg_temp.rec('K2 as contractor 1, the visible rows are only their own (2: the fixture row and the one just inserted)', pg_temp.count_as('authenticated', u1, 'c1@example.test'), '2', '');
  PERFORM pg_temp.rec('K3 the owner''s account still reads every row', pg_temp.count_as('authenticated', gen_random_uuid(), adm), '3', '');
  r := pg_temp.try_as('service_role', NULL, '', format('UPDATE public.fee_acceptances SET invoice_url = ''https://example.test/inv'' WHERE id = %L', f2));
  PERFORM pg_temp.rec('K4 service_role UPDATE still works (server-side maintenance path)', r, 'ok rows=1', '');
  r := pg_temp.try_as('service_role', NULL, '', format('DELETE FROM public.fee_acceptances WHERE claim_id = %L', cl));
  PERFORM pg_temp.rec('K5 service_role DELETE by claim_id still works (tests/e2e/seed/teardown.mjs shape)', r, 'ok rows=3', '');
END $f$;
SELECT pg_temp.run();
SELECT 'FAILING=' || count(*) FILTER (WHERE NOT ok) || ' of ' || count(*) FROM proof_r;
SELECT n || ' | ' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || ' | ' || label || ' | got=' || got || CASE WHEN ok THEN '' ELSE ' | expected=' || expected || ' | ' || detail END FROM proof_r ORDER BY n;
ROLLBACK;
