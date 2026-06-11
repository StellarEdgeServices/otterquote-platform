-- v86_drop_activity_log_event_type_check_rollback.sql
-- Rollback for: Drop activity_log.event_type CHECK (v86_drop_activity_log_event_type_check.sql)
-- ClickUp: 86e1tz17j
--
-- Restores the ORIGINAL 8-value CHECK, but adds it as NOT VALID.
--
-- WHY NOT VALID: once v86 is live, activity_log will (correctly) accumulate rows
-- with event_types outside the original 8 — bid_confirmation_email_sent,
-- invoice_created, homeowner_contract_signed_email_sent, and any future types.
-- A plain ADD CONSTRAINT re-validates ALL existing rows and would FAIL on those.
-- NOT VALID re-arms the constraint for FUTURE writes without rejecting historical
-- audit rows — the only rollback that does not destroy audit data.
--
-- NOTE: a NOT VALID rollback will REJECT future inserts of the (legitimate) EF
-- event_types again — i.e. it re-introduces the original bug for new rows. This
-- rollback exists for deploy-chain completeness only; if v86 ever needs reverting,
-- pair it with reverting the EF Sentry/non-swallow change and confirm with Dustin,
-- because rolling back re-creates the silent-loss condition on the revenue path.

BEGIN;

ALTER TABLE public.activity_log
  DROP CONSTRAINT IF EXISTS activity_log_event_type_check;

ALTER TABLE public.activity_log
  ADD CONSTRAINT activity_log_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'bid_submitted','bid_accepted','bid_rejected','opportunity_matched',
    'profile_updated','settings_updated','contract_signed','job_completed'
  ])) NOT VALID;

COMMIT;
