-- ============================================================================
-- gh-2154 P-3 review round 2 ROLLBACK: remove notifications.referral_agent_id
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS public.notifications_partner_alert_dedupe_idx;
ALTER TABLE public.notifications DROP COLUMN IF EXISTS referral_agent_id;

COMMIT;
