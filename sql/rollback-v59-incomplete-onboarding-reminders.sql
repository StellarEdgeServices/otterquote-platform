-- Rollback v59
SELECT cron.unschedule('send-incomplete-onboarding-reminders');
DELETE FROM public.rate_limit_config WHERE function_name = 'send-incomplete-onboarding-reminders';
ALTER TABLE public.contractors DROP COLUMN IF EXISTS partial_completion_email_sent_at;
