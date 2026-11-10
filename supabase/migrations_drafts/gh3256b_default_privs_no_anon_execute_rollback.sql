-- STATUS (gh-1438, as of 2026-11-10): NOT APPLIED
-- FILE ROLE: rollback file of set gh3256b_default_privs_no_anon_execute (forward and pre-flight beside it)
-- EVIDENCE: drafted 2026-11-10 under #3256. Restores postgres's function defaults: (postgres, public, f) back to include anon=X, and PUBLIC=X back to the built-in default. No database was written to produce this file.
-- REPO COPY: none. When the forward is applied, move this file to supabase/migrations_rollbacks/ under the forward's ledger version.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: gh3256b_default_privs_no_anon_execute. Functions postgres creates afterwards get EXECUTE for anon and PUBLIC again. Functions
-- created while the forward was in force keep their ACLs. Safe to run twice. The proof checks pg_default_acl is identical to the pre-forward state.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;

COMMIT;
