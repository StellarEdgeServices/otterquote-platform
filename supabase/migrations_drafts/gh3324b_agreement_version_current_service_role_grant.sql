-- STATUS (gh-1438, as of 2026-11-11T21:00:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3324b_agreement_version_current_service_role_grant (rollback beside it)
-- EVIDENCE: drafted 2026-11-11 under #3324 (PR #3665, REVIEW 6806737854 finding 1, DECIDED 6806748788). Production read-only 2026-11-11 (reviewer): has_table_privilege('service_role','public.agreement_version_current','SELECT') = false, because supabase/migrations/20261029190222_gh3073_agreement_version_stamp.sql (ledger version 20261029190222) runs REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role and grants no service_role privilege. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3324b_agreement_version_current_service_role_grant
-- GitHub: #3324. Tier: 3A (additive, one SELECT grant to service_role on a single-row config table; no client role gains anything).
-- Rollback: supabase/migrations_drafts/gh3324b_agreement_version_current_service_role_grant_rollback.sql
--
-- WHAT. GRANT SELECT ON public.agreement_version_current TO service_role. Nothing else changes. anon, authenticated and PUBLIC stay revoked.
-- Rerun-safe: granting an already-held privilege is a no-op; the post-check passes on a second run.
BEGIN;

SET LOCAL lock_timeout = '5s';

GRANT SELECT ON TABLE public.agreement_version_current TO service_role;

DO $post$
BEGIN
  IF NOT has_table_privilege('service_role', 'public.agreement_version_current', 'SELECT') THEN
    RAISE EXCEPTION 'gh3324b: service_role still lacks SELECT on public.agreement_version_current';
  END IF;
  IF has_table_privilege('anon', 'public.agreement_version_current', 'SELECT')
     OR has_table_privilege('authenticated', 'public.agreement_version_current', 'SELECT') THEN
    RAISE EXCEPTION 'gh3324b: a client role holds SELECT on public.agreement_version_current';
  END IF;
END
$post$;

COMMIT;
