-- STATUS (gh-1438, as of 2026-10-30T21:30:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3256_default_privs_no_client_truncate (rollback and pre-flight beside it)
-- EVIDENCE: drafted 2026-10-30 under #3256. Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa, PG 17.6): pg_default_acl for (postgres, public, tables) = {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}; the same for (supabase_admin, public, tables) with grantor supabase_admin. current_user of the migration path is postgres, rolsuper = false, pg_has_role('postgres','supabase_admin','MEMBER') = false; every public table (63) and view (11) is owned by postgres. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3256_default_privs_no_client_truncate
-- GitHub: #3256 (follow-up to #3240 / PR #3252, REVIEW 6527318575 finding 2). Project P18.
-- Tier: 3B (changes default privileges; removes a capability from client roles on every FUTURE public table). R-097 notice.
-- Rollback: supabase/migrations_drafts/gh3256_default_privs_no_client_truncate_rollback.sql (exact inverse)
-- Pre-flight: supabase/migrations_drafts/gh3256_default_privs_no_client_truncate_pre-flight.md
-- Proof: bash supabase/tests/gh3256_default_privs_proof_run.sh (throwaway PG16 cluster bootstrapped as supabase_admin, with
--   postgres a non-superuser non-member exactly as in production: before / after / rerun / rollback, mutants, capability check)
--
-- WHAT. New tables in public created by postgres (the migration role) stop inheriting TRUNCATE for anon and authenticated.
--   Every other default privilege (SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN) and service_role's TRUNCATE are
--   unchanged. EXISTING tables are not touched (#3252 covers those); sequences and functions defaults are not touched.
--
-- WHY NOT supabase_admin TOO. ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin requires membership in supabase_admin or superuser.
--   postgres has neither in production, so that statement fails with 42501 (shown in the proof). It is therefore NOT in this file:
--   a conditional attempt would make the rollback depend on which branch ran. Tables created as supabase_admin (none in public
--   today; it would take a Supabase-managed path or a support-run script) keep the old defaults. The fallback #3256 asks for is in
--   the same PR: scripts/new-table-truncate-revoke-check.py, a diff-scoped CI gate that fails any migration creating a public
--   table without REVOKE TRUNCATE from anon and authenticated.
--
-- Rerun-safe: revoking an absent default privilege is a no-op; the assertions pass on a second run.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon, authenticated;

DO $post$
DECLARE
  v_client_truncate int; v_client_roles int; v_client_other int; v_service_truncate int;
BEGIN
  SELECT count(*) FILTER (WHERE e.grantee IN ('anon'::regrole, 'authenticated'::regrole) AND e.privilege_type = 'TRUNCATE'),
         count(DISTINCT e.grantee) FILTER (WHERE e.grantee IN ('anon'::regrole, 'authenticated'::regrole)),
         count(*) FILTER (WHERE e.grantee IN ('anon'::regrole, 'authenticated'::regrole)
                            AND e.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'TRIGGER')),
         count(*) FILTER (WHERE e.grantee = 'service_role'::regrole AND e.privilege_type = 'TRUNCATE')
    INTO v_client_truncate, v_client_roles, v_client_other, v_service_truncate
    FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) e
   WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'r';
  IF v_client_truncate <> 0 THEN
    RAISE EXCEPTION 'gh3256: anon/authenticated still carry TRUNCATE in postgres''s public table defaults (% entries)', v_client_truncate USING ERRCODE = 'P0B57';
  END IF;
  IF v_client_roles <> 2 OR v_client_other <> 12 THEN
    RAISE EXCEPTION 'gh3256: anon/authenticated lost a default privilege other than TRUNCATE (roles=%, privileges=%, want 2/12)', v_client_roles, v_client_other USING ERRCODE = 'P0B57';
  END IF;
  IF v_service_truncate <> 1 THEN
    RAISE EXCEPTION 'gh3256: service_role lost TRUNCATE in the defaults' USING ERRCODE = 'P0B57';
  END IF;
END
$post$;

COMMIT;
