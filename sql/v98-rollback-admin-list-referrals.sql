-- ============================================================================
-- v98 ROLLBACK — Admin referral visibility RPC  (GitHub #599)
-- ============================================================================
--
-- Drops admin_list_referrals(). admin-referrals.html's Referrals section will
-- show an error and fall back to the Partners table; no other surface calls it.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.admin_list_referrals();

COMMIT;
