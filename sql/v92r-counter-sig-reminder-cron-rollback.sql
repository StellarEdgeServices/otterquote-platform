-- v92 rollback: remove counter-sig-reminders pg_cron schedule + rate limit row
-- (D-149 counter-signature nudge cadence, ClickUp 86e1gabf4)
--
-- Does NOT remove the Edge Function itself — undeploy separately via CLI if needed.
-- Does NOT delete any notifications rows already written
--   (countersign_nudge_pending / countersign_reminder_sent are audit trail).
-- The immediate nudge in docusign-webhook is code, not cron — reverting it
--   requires reverting the D-149 PR, not this file.

SELECT cron.unschedule('counter-sig-reminders');

DELETE FROM rate_limit_config WHERE function_name = 'counter-sig-reminders';
