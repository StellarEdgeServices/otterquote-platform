-- STATUS (gh-1438, as of 2026-11-10): NOT APPLIED
-- FILE ROLE: forward file of set gh3256b_default_privs_no_anon_execute (rollback and pre-flight beside it)
-- EVIDENCE: Supabase security advisor 2026-11-10T17:35Z (CTO RUN 101 brief): default privileges also grant EXECUTE on NEW functions to anon/PUBLIC, which is how fee_acceptance_quarantine_add became anon-callable (fixed one-off in PR #3608). Production read-only 2026-11-05 (CLOSE-REVIEW 6667270139, project yeszghaspzwwstvsrioa): pg_default_acl (postgres, public, f) = {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}; (supabase_admin, public, f) the same with grantor supabase_admin. The built-in PUBLIC=X default is not a pg_default_acl row at all, so it never shows in that listing. Production read-only again 2026-11-10 (CTO RUN 102 worker): the full pg_default_acl has no global (schema-less) row for postgres or supabase_admin, so the global PUBLIC revoke below starts from the built-in default; its listing is in the pre-flight. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3256b_default_privs_no_anon_execute
-- GitHub: #3256 (scope addition, CTO RUN 101). Project P18. Tier 3B (changes default privileges on every FUTURE postgres-created function). R-097 notice.
-- Rollback: supabase/migrations_drafts/gh3256b_default_privs_no_anon_execute_rollback.sql (exact inverse)
-- Proof: bash supabase/tests/gh3256b_default_privs_functions_proof_run.sh (throwaway PG16 cluster bootstrapped as supabase_admin)
--
-- WHAT. Functions that postgres (the migration role) creates AFTER this runs no longer get EXECUTE for anon or PUBLIC, EXCEPT in schema storage (see STORAGE below).
--   IN SCHEMA public, authenticated, service_role and the owner keep the EXECUTE they get today (the public-schema default row still lists
--   them), so a new RPC the signed-in app calls still works with no extra GRANT. OUTSIDE schemas public and storage that is NOT true: a new function
--   postgres creates in another schema (for example a private schema) gets EXECUTE for the owner only, because authenticated and service_role
--   used to receive it through PUBLIC. Such a function needs an explicit GRANT EXECUTE to authenticated and/or service_role in its own
--   migration. No function in this repo is created outside public today (REVIEW 6776836494).
--   STORAGE. Production has a (postgres, storage, f) default row = {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}.
--   This migration does not change it, and a schema-specific row adds to the global one, so a function postgres creates in schema storage STILL gets EXECUTE
--   for anon, authenticated and service_role. No function in this repo is created in storage today (REVIEW 6777966561).
--   A function that anon must call now needs an explicit GRANT EXECUTE ... TO anon in its own migration (the pattern the repo already
--   uses for the public RPCs). Likewise a DROP FUNCTION + CREATE FUNCTION of an anon-callable function must repeat its GRANT
--   (CREATE OR REPLACE keeps grants). EXISTING functions are not touched. Tables, sequences and every other schema's table/sequence defaults are not touched.
--
-- TWO STATEMENTS, AND WHY THE SECOND IS NOT SCOPED TO public.
--   1. IN SCHEMA public ... FROM anon removes the explicit anon entry from postgres's public function defaults.
--   2. PUBLIC's EXECUTE is Postgres's built-in default for functions, not an entry in the public-schema row, and a schema-scoped REVOKE
--      cannot subtract it (the proof shows `IN SCHEMA public ... FROM PUBLIC` leaves =X on a new function). Anon inherits PUBLIC, so
--      without statement 2 statement 1 changes nothing. Statement 2 is therefore the global form, FOR ROLE postgres with no IN SCHEMA: it
--      applies to functions postgres creates in ANY schema from now on, which is why the outside-public consequence above exists. Functions
--      owned by supabase_admin are not reached (this includes extension objects: trusted extensions are created by the superuser, not by
--      postgres). Existing objects are not touched. Dustin: this widening beyond schema public is the one judgment call in this file; the rollback undoes it.
--
-- WHY NOT supabase_admin. ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin needs membership in supabase_admin or superuser; postgres has
--   neither in production, so it fails 42501 (shown in the proof). Functions created as supabase_admin keep the old defaults. Every
--   public function in this repo is created through migrations as postgres.
--
-- Rerun-safe: revoking an absent default privilege is a no-op; the assertions pass on a second run.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $post$
DECLARE
  v_anon int; v_keep int; v_probe oid; v_anon_exec boolean; v_auth_exec boolean; v_svc_exec boolean;
BEGIN
  SELECT count(*) FILTER (WHERE e.grantee = 'anon'::regrole AND d.defaclnamespace = 'public'::regnamespace),
         count(*) FILTER (WHERE d.defaclnamespace = 'public'::regnamespace AND e.grantee IN ('authenticated'::regrole, 'service_role'::regrole) AND e.privilege_type = 'EXECUTE')
    INTO v_anon, v_keep
    FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) e
   WHERE d.defaclrole = 'postgres'::regrole AND d.defaclobjtype = 'f';
  IF v_anon <> 0 THEN
    RAISE EXCEPTION 'gh3256b: anon still has EXECUTE in postgres''s public function defaults (% entries)', v_anon USING ERRCODE = 'P0B57';
  END IF;
  IF v_keep <> 2 THEN
    RAISE EXCEPTION 'gh3256b: authenticated/service_role lost EXECUTE in the public function defaults (% entries, want 2)', v_keep USING ERRCODE = 'P0B57';
  END IF;
  -- PUBLIC's built-in EXECUTE is not visible in pg_default_acl, so probe the effective result with a throwaway function (dropped below, inside this transaction).
  CREATE FUNCTION public.gh3256b_probe() RETURNS int LANGUAGE sql AS 'select 1';
  v_probe := 'public.gh3256b_probe()'::regprocedure::oid;
  v_anon_exec := has_function_privilege('anon', v_probe, 'EXECUTE');
  v_auth_exec := has_function_privilege('authenticated', v_probe, 'EXECUTE');
  v_svc_exec  := has_function_privilege('service_role', v_probe, 'EXECUTE');
  DROP FUNCTION public.gh3256b_probe();
  IF v_anon_exec THEN
    RAISE EXCEPTION 'gh3256b: a new postgres function is still executable by anon (PUBLIC or anon default remains)' USING ERRCODE = 'P0B57';
  END IF;
  IF NOT (v_auth_exec AND v_svc_exec) THEN
    RAISE EXCEPTION 'gh3256b: a new postgres function is not executable by authenticated/service_role (auth=%, service=%)', v_auth_exec, v_svc_exec USING ERRCODE = 'P0B57';
  END IF;
END
$post$;

COMMIT;
