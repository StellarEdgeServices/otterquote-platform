-- Rollback for the D-339 leads-retention purge job.
-- Removes the cron schedule and the function; does not (and cannot)
-- restore rows already deleted by a prior run of this job -- there are
-- none, because this migration has never been applied.
BEGIN;

SELECT cron.unschedule('d339-leads-retention-purge');
DROP FUNCTION IF EXISTS public.purge_expired_leads(boolean);

COMMIT;
