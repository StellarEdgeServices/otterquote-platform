-- Rollback for 20260925222500_gh2154_p5_invite_reminder_stage.sql.
--
-- Restores partner_onboarding_sends.stage's CHECK to its exact pre-this-
-- migration, live form (confirmed by the forward migration's own read-only
-- probe): stage = ANY ('day0','day1','day3','day7').
--
-- Any 'invite_reminder' row inserted while the widened constraint was live
-- would violate the restored, narrower CHECK -- so this rollback deletes
-- 'invite_reminder' rows FIRST. Safe: those rows are pure send-status
-- bookkeeping for send-partner-invite-reminder (never referenced by any
-- other table, function, or FK), and rolling this migration back only
-- happens as part of reverting the whole P-5 invite-reminder feature,
-- which stops sending reminders entirely -- there is nothing left in the
-- system that reads these rows once the feature is gone.

BEGIN;

DELETE FROM public.partner_onboarding_sends WHERE stage = 'invite_reminder';

ALTER TABLE public.partner_onboarding_sends
  DROP CONSTRAINT partner_onboarding_sends_stage_check;

ALTER TABLE public.partner_onboarding_sends
  ADD CONSTRAINT partner_onboarding_sends_stage_check
  CHECK (stage = ANY (ARRAY['day0'::text, 'day1'::text, 'day3'::text, 'day7'::text]));

-- The base ledger migration (20260924210000) never set a column-level
-- comment on .stage (only a table-level one, untouched by either
-- migration) -- restore to that exact state, not an invented one.
COMMENT ON COLUMN public.partner_onboarding_sends.stage IS NULL;

COMMIT;
