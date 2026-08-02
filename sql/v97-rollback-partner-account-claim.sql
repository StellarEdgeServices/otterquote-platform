-- ============================================================================
-- v97 ROLLBACK — Partner account claim RPC  (GitHub #594)
-- ============================================================================
--
-- Drops claim_partner_account(). Reverts the platform to the state where
-- partner user_id linkage is impossible from the client (see v97 header) —
-- so only roll back if the RPC itself is causing harm, not merely to undo.
--
-- NOT REVERSED: the user_id backfill in v97. Those rows were linked to the
-- correct auth.users accounts by exact email match; un-linking them would
-- re-break dashboards for no benefit. To reverse manually (not recommended):
--   UPDATE public.referral_agents SET user_id = NULL WHERE id IN (...);
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.claim_partner_account();

COMMIT;
