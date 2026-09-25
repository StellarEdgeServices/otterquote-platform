-- Rollback for supabase/migrations/20260925020000_gh2121_lead_next_step_reminder.sql
--
-- Drops only what that file added: the rate_limit_config row for this
-- function name, and the two new `leads` columns. Does NOT touch any other
-- column or row on `leads` (in particular, is_synthetic and
-- converted_user_id are untouched) and does NOT touch rate_limit_config
-- rows for any other function_name.
--
-- Safe to run even if send-lead-next-step-reminder has already stamped rows
-- (next_step_reminder_sent_at / next_step_reminder_opted_out_at values are
-- simply dropped along with the columns) -- this is a feature rollback, not
-- a data-preservation migration; if a rollback that preserves those stamps
-- is ever needed, capture them into a separate table before running this.

BEGIN;

DROP INDEX IF EXISTS public.leads_next_step_reminder_sent_email_uidx;

DELETE FROM public.rate_limit_config WHERE function_name = 'send-lead-next-step-reminder';

ALTER TABLE public.leads DROP COLUMN IF EXISTS next_step_reminder_opted_out_at;
ALTER TABLE public.leads DROP COLUMN IF EXISTS next_step_reminder_sent_at;

COMMIT;
