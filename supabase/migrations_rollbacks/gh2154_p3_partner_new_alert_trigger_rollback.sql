-- ============================================================================
-- gh-2154 P-3 ROLLBACK: remove new-partner admin alert trigger
-- ============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_notify_admin_new_partner ON public.referral_agents;
DROP FUNCTION IF EXISTS public.notify_admin_new_partner();

COMMIT;
