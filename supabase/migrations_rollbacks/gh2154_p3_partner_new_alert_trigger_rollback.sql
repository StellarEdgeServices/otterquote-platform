-- ============================================================================
-- gh-2154 P-3 ROLLBACK: remove new-partner admin alert trigger
-- ============================================================================
-- Run this BEFORE gh2154_p3_notifications_referral_agent_id_rollback.sql if
-- rolling back both P-3 migrations (reverse of the go-live order: column,
-- then EF, then trigger -- so roll back trigger, then column).

BEGIN;

DROP TRIGGER IF EXISTS trg_notify_admin_new_partner ON public.referral_agents;
DROP FUNCTION IF EXISTS public.notify_admin_new_partner();

COMMIT;
