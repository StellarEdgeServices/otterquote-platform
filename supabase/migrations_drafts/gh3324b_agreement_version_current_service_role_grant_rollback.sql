-- STATUS (gh-1438, as of 2026-11-11T21:00:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3324b_agreement_version_current_service_role_grant (forward beside it)
-- EVIDENCE: drafted 2026-11-11 under #3324 (PR #3665, DECIDED 6806748788). Restores the state read in production 2026-11-11: service_role holds no privilege on public.agreement_version_current. No database was written to produce this file.
-- REPO COPY: none. When the forward is applied, move this file to supabase/migrations_rollbacks/ under the forward's ledger version.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: gh3324b_agreement_version_current_service_role_grant. Revokes SELECT from service_role. Safe to run twice.
BEGIN;

SET LOCAL lock_timeout = '5s';

REVOKE SELECT ON TABLE public.agreement_version_current FROM service_role;

DO $post$
BEGIN
  IF has_table_privilege('service_role', 'public.agreement_version_current', 'SELECT') THEN
    RAISE EXCEPTION 'gh3324b rollback: service_role still holds SELECT on public.agreement_version_current';
  END IF;
END
$post$;

COMMIT;
