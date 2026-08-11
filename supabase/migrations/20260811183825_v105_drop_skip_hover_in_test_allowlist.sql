-- ============================================================================
-- v105 — Drop dead `skip_hover_in_test` key from platform_settings RLS allow-list
-- (GitHub #702, carved out of #484 AC 3)
-- ============================================================================
--
-- CONTEXT
--   v87 (20260703222148) added a SELECT allow-list policy on platform_settings
--   scoped to four keys, including 'skip_hover_in_test'. That key has zero
--   application references anywhere in the repo — confirmed by local grep
--   (repo-scoped GitHub code search is known-unreliable for this repo, #690;
--   this finding is NOT based on it). The only occurrence in the entire
--   working tree is the v87 allow-list entry itself. No code reads or writes
--   this platform_settings row, and no test path depends on it.
--
-- CHANGE
--   Recreate the policy with the same three remaining keys, dropping
--   'skip_hover_in_test'. Purely a narrowing of an allow-list — no other
--   policy, table, or column is touched. Since nothing reads this key today,
--   this is a behavioral no-op; the only effect is that the row (if it
--   exists) becomes unreadable via this policy going forward.
--
-- TIER: 3 (RLS policy on platform_settings). Requires Dustin's review and
--   approval before this is applied — per #702 AC and migration-author
--   standing rule. DO NOT APPLY TO PRODUCTION FROM A CODE-LANE SESSION.
--
-- Rollback: 20260811183825_v105_rollback_drop_skip_hover_in_test_allowlist.sql
--   (restores the four-key allow-list verbatim, including skip_hover_in_test).
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "Authenticated can read public settings" ON public.platform_settings;
CREATE POLICY "Authenticated can read public settings" ON public.platform_settings
  FOR SELECT TO authenticated
  USING (key IN ('D204_HARD_FILTER',
                 'hover_measurement_price',
                 'platform_fee_percentage'));

COMMIT;
