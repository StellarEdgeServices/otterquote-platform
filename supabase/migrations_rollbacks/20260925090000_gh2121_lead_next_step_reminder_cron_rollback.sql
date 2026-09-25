-- Rollback for supabase/migrations/20260925090000_gh2121_lead_next_step_reminder_cron.sql
--
-- Unschedules the pg_cron job only. Does not touch the kill switch row, the
-- two `leads` columns, or the unique index -- those belong to
-- 20260925020000_gh2121_lead_next_step_reminder.sql and its own rollback.

BEGIN;

SELECT cron.unschedule('gh2121-lead-next-step-reminder');

COMMIT;
