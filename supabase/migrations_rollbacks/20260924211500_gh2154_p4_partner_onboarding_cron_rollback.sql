-- ============================================================================
-- gh-2154 P-4 ROLLBACK: unschedule the partner onboarding sweep cron job
-- ============================================================================

BEGIN;

SELECT cron.unschedule('gh2154-p4-partner-onboarding-sweep');

COMMIT;
