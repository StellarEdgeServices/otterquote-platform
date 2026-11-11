-- STATUS (gh-1438, as of 2026-10-30T21:30:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3256_default_privs_no_client_truncate (forward and pre-flight beside it)
-- EVIDENCE: drafted 2026-10-30 under #3256. Restores the production default ACL read 2026-10-30 (project yeszghaspzwwstvsrioa): (postgres, public, tables) = {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}. No database was written to produce this file.
-- REPO COPY: none. When the forward is applied, move this file to supabase/migrations_rollbacks/ under the forward's ledger version.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: gh3256_default_privs_no_client_truncate. Gives TRUNCATE back to anon and authenticated in postgres's default privileges
-- for new public tables. FOR ROLE postgres records grantor postgres whoever runs it (postgres, or a superuser). Tables created while the forward was in force keep their ACLs; this only
-- changes what tables created afterwards inherit. Safe to run twice. The proof checks pg_default_acl is identical to the pre-forward state.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT TRUNCATE ON TABLES TO anon, authenticated;

COMMIT;
