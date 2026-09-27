-- Rollback for the D-339 leads-retention purge job. ROUND 2: made
-- idempotent per N3 (REVIEW: FAIL 5858446793) -- the reviewer proved
-- `cron.unschedule('d339-leads-retention-purge')` raises "could not find
-- valid entry for job" when the job is missing (e.g. a second rollback
-- run, or rolling back a migration that was never applied). The guarded
-- form below is a no-op instead of an error when there is nothing to
-- unschedule.
--
-- Removes the cron schedule and the function; does not (and cannot)
-- restore rows a live run has already deleted -- recovery for those is
-- possible only from a Supabase backup or PITR, if one still covers the
-- date, never from this file.
BEGIN;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'd339-leads-retention-purge';
END;
$$;

DROP FUNCTION IF EXISTS public.purge_expired_leads(boolean);

COMMIT;
