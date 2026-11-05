-- gh-3240 proof: anon and authenticated no longer hold TRUNCATE on any public relation; nothing else changed.
-- THROWAWAY Postgres only, after gh3240_revoke_client_truncate_scratch_setup.sql. Run with `psql -1`: the last statement is a
-- deliberate RAISE, so the TRUNCATE attempts and probes below roll back and every phase starts from the same rows.
-- Report: 'PROOF-OK all 10 checks passed', or 'PROOF-FAIL' followed by one 'FAIL <check> got=<value> want=<value>' line per failure.
--   BEFORE the forward (negative control): C1-C5 fail (the defect). AFTER / re-run / re-applied: PROOF-OK.
CREATE TEMP TABLE _r(k text, got text, want text) ON COMMIT DROP;

CREATE FUNCTION pg_temp.as_role(p_role text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text := 'ok';
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v := 'ERR ' || SQLSTATE;
  END;
  RESET ROLE;
  RETURN v;
END $f$;

-- C1 the issue's closes-on query
INSERT INTO _r SELECT 'C1 referrals TRUNCATE anon,authenticated',
  has_table_privilege('anon','public.referrals','TRUNCATE')::text || ',' || has_table_privilege('authenticated','public.referrals','TRUNCATE')::text, 'false,false';
-- C2 the issue's sweep: no public relation grants TRUNCATE to a client role
INSERT INTO _r SELECT 'C2 public relations granting TRUNCATE to anon/authenticated',
  coalesce((SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
               AND (has_table_privilege('anon', c.oid, 'TRUNCATE') OR has_table_privilege('authenticated', c.oid, 'TRUNCATE'))), '<none>'), '<none>';
-- C3-C5 behaviour: the statement itself is refused
INSERT INTO _r SELECT 'C3 authenticated TRUNCATE public.referrals', pg_temp.as_role('authenticated', 'TRUNCATE public.referrals'), 'ERR 42501';
INSERT INTO _r SELECT 'C4 anon TRUNCATE public.referrals', pg_temp.as_role('anon', 'TRUNCATE public.referrals'), 'ERR 42501';
INSERT INTO _r SELECT 'C5 authenticated TRUNCATE public.leads', pg_temp.as_role('authenticated', 'TRUNCATE public.leads'), 'ERR 42501';
-- C6 the referrals rows survived the attempts
INSERT INTO _r SELECT 'C6 referrals rows after the attempts', (SELECT count(*) FROM public.referrals)::text, '2';
-- C7 nothing but anon/authenticated TRUNCATE changed: every relacl equals the setup baseline once 'D' is removed from those two entries
INSERT INTO _r SELECT 'C7 relations whose ACL changed beyond client TRUNCATE',
  coalesce((SELECT string_agg(b.relname, ',' ORDER BY b.relname)
              FROM gh3240_proof.baseline b
              LEFT JOIN (SELECT c.relname::text AS relname, c.relacl::text AS relacl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')) cur USING (relname)
             WHERE cur.relname IS NULL
                OR regexp_replace(regexp_replace(b.relacl, '(anon=[a-zA-Z]*?)D', '\1'), '(authenticated=[a-zA-Z]*?)D', '\1')
                   IS DISTINCT FROM
                   regexp_replace(regexp_replace(cur.relacl, '(anon=[a-zA-Z]*?)D', '\1'), '(authenticated=[a-zA-Z]*?)D', '\1')), '<none>'), '<none>';
-- C8 column grants (referrals' #3217 allow-list) untouched
INSERT INTO _r SELECT 'C8 relations whose column ACLs changed',
  coalesce((SELECT string_agg(b.relname, ',') FROM gh3240_proof.baseline b
             WHERE b.colacl IS DISTINCT FROM (SELECT string_agg(a.attname || '=' || a.attacl::text, ';' ORDER BY a.attnum)
                                               FROM pg_attribute a WHERE a.attrelid = ('public.' || quote_ident(b.relname))::regclass AND a.attacl IS NOT NULL)), '<none>'), '<none>';
-- C9 service_role keeps TRUNCATE wherever it had it
INSERT INTO _r SELECT 'C9 relations where service_role TRUNCATE differs from baseline',
  coalesce((SELECT string_agg(b.relname, ',') FROM gh3240_proof.baseline b
             WHERE (coalesce(b.relacl, '') ~ 'service_role=[a-zA-Z]*D') <> has_table_privilege('service_role', ('public.' || quote_ident(b.relname))::regclass, 'TRUNCATE')), '<none>'), '<none>';
-- C10 the server-side path still works: service_role can truncate (edge functions are unaffected)
INSERT INTO _r SELECT 'C10 service_role TRUNCATE public.cron_health', pg_temp.as_role('service_role', 'TRUNCATE public.cron_health'), 'ok';

-- INFO (not a check): pg_default_acl still grants TRUNCATE on tables created later. Out of scope for #3240; flagged in the PR.
CREATE TABLE public.gh3240_info_new_table (id int);
INSERT INTO _r SELECT 'new public table: anon TRUNCATE via default ACL', has_table_privilege('anon','public.gh3240_info_new_table','TRUNCATE')::text, NULL;

DO $f$
DECLARE s text; nfail int; ncheck int;
BEGIN
  SELECT count(*) FILTER (WHERE got IS DISTINCT FROM want), count(*) INTO nfail, ncheck FROM _r WHERE want IS NOT NULL;
  SELECT string_agg(CASE WHEN want IS NULL THEN 'INFO ' || k || ' => ' || got
                         WHEN got IS DISTINCT FROM want THEN 'FAIL ' || k || ' got=' || coalesce(got,'NULL') || ' want=' || want
                         ELSE 'ok   ' || k || ' => ' || got END, E'\n' ORDER BY k) INTO s FROM _r;
  IF nfail = 0 AND ncheck = 10 THEN
    RAISE EXCEPTION E'GH3240 PROOF (forced rollback) PROOF-OK all % checks passed\n%', ncheck, s USING ERRCODE = 'P0U01';
  ELSE
    RAISE EXCEPTION E'GH3240 PROOF (forced rollback) PROOF-FAIL % of % checks failed\n%', nfail, ncheck, s USING ERRCODE = 'P0U01';
  END IF;
END $f$;
