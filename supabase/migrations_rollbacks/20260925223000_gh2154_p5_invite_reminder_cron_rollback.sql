-- ============================================================================
-- gh-2154 P-5 ROLLBACK: unschedule the invite reminder sweep cron job
-- ============================================================================

BEGIN;

SELECT cron.unschedule('gh2154-p5-invite-reminder-sweep');

COMMIT;
