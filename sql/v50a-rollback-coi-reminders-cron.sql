-- Rollback for v50a-coi-reminders-cron.sql
-- Generated 2026-06-08 | Tier 3 deploy required (D-182)
-- Run ONLY after confirming the forward migration is what you're rolling back.
-- Verified 2026-06-08: cron job 'process-coi-reminders' (0 8 * * *) and
-- rate_limit_config row both exist in production before this rollback was written.

-- Unschedule pg_cron job added by v50a
SELECT cron.unschedule('process-coi-reminders');

-- Remove rate_limit_config entry added by v50a
DELETE FROM rate_limit_config
WHERE function_name = 'process-coi-reminders';
