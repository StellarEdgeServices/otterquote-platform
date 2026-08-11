-- ============================================================================
-- v107 — Drop dead `skip_hover_in_test` key from the platform_settings RLS
-- allow-list (GitHub #702, carved out of #484 item 3)
-- ============================================================================
--
-- DRAFT — NOT APPLIED. Tier 3 migration; requires migration-author + Dustin
-- approval per this repo's standing rule (this issue's own AC item 4).
--
-- Confirmed dead by local repo-wide grep (not GitHub code search — #690):
-- the only reference to `skip_hover_in_test` anywhere in the repository is
-- the v87 RLS allow-list entry itself. No application code reads or writes
-- this platform_settings key. Re-verified live against production
-- (pg_policy.polqual on public.platform_settings) — matches the v87
-- migration file exactly, no drift.
--
-- Expected behavioral impact: NONE. Nothing references this key, so nothing
-- should change. That "no-op in behavior" is the expected closure evidence
-- per this issue's own AC.
--
-- Rollback: sql/v107-rollback-drop-dead-skip-hover-in-test-flag.sql
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "Authenticated can read public settings" ON public.platform_settings;
CREATE POLICY "Authenticated can read public settings" ON public.platform_settings
  FOR SELECT TO authenticated
  USING (key IN ('D204_HARD_FILTER',
                 'hover_measurement_price',
                 'platform_fee_percentage'));

COMMIT;
