-- STATUS (gh-1438, as of 2026-09-30T12:32Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh1026_drop_admin_contractor_last_logins (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: the DROP VIEW has not run (view still exists; authenticated SELECT already revoked live): comment 5494221280 (RW-DONE, PR #1471, supabase/migrations/MIGRATIONS-RECONCILIATION-1438.md Part 1, read-only queries 2026-09-01); comment 5850997376 (CLOSE-REVIEW 2026-09-26). Not re-measured since; re-query the live ledger before relying on it.
-- REPO COPY: none in supabase/migrations/ or supabase/migrations_rollbacks/ for this file
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: gh1026_drop_admin_contractor_last_logins_rollback.sql
-- Reverts: gh1026_drop_admin_contractor_last_logins.sql
-- Status: DRAFT — forward migration not yet applied.
-- GitHub: #1026
--
-- Recreates the view with its exact live definition (verified this session
-- via pg_get_viewdef against yeszghaspzwwstvsrioa) and its original grant
-- shape from sql/v41-admin-last-login-view.sql, in case something unlisted
-- still depends on the view existing (nothing was found in the repo grep,
-- but the object holds no data either way — recreating it is lossless).
-- Note: this restores the OBJECT, not the `authenticated` SELECT grant that
-- was already revoked live prior to this migration (Session 349 security
-- fix) — that revoke predates this change and is out of scope to reverse
-- here. Restoring it would re-open the WHERE-clause-gated access path the
-- RPC replaced for security reasons, which this rollback intentionally
-- does not do.

BEGIN;

CREATE OR REPLACE VIEW public.admin_contractor_last_logins AS
SELECT
    c.id AS contractor_id,
    u.last_sign_in_at
FROM contractors c
LEFT JOIN auth.users u ON c.user_id = u.id
WHERE (SELECT auth.email()) = 'dustinstohler1@gmail.com';

COMMENT ON VIEW public.admin_contractor_last_logins IS
    'Admin-only view: last_sign_in_at for all contractors joined from auth.users. '
    'Restricted by auth.email() — non-admin sessions always receive 0 rows. '
    'Recreated by gh1026 rollback; superseded by public.get_contractor_last_logins() RPC — '
    'do not repoint any consumer back to this view without re-reading gh-1026.';

-- Original grant shape only extended SELECT to `authenticated`, and revoked
-- anon explicitly. `authenticated` SELECT is intentionally NOT restored
-- here — that grant was already revoked live before this migration existed
-- (Session 349 security fix), independent of the drop/rollback pair.
REVOKE ALL ON public.admin_contractor_last_logins FROM anon;

COMMIT;
