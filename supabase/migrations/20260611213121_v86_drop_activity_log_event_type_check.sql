-- v86_drop_activity_log_event_type_check.sql
-- Migration: Drop the fail-closed CHECK constraint on activity_log.event_type
-- ClickUp: 86e1tz17j
-- CTO Decision Date: 2026-06-11 (Path A — DROP, approved by Dustin)
-- D-numbers: Tier 3 approval (Dustin 2026-06-11); D-215 (invoice audit trail); D-221 (deploy chain)
--
-- PROBLEM (verified against deployed EF source 2026-06-11, project yeszghaspzwwstvsrioa):
--   activity_log.event_type carried a CHECK allowing only 8 values. Three live
--   Edge Functions insert event_types OUTSIDE that set and SWALLOW the resulting
--   error (non-fatal `if (logError) console.error(...)`), so production returned
--   200 while the audit row was silently dropped. activity_log contained only
--   `bid_submitted` (20 rows) at investigation time.
--
--   Rejected event_types + writer EF:
--     bid_confirmation_email_sent            — send-bid-confirmation v18
--     invoice_created                        — create-invoice v16   (D-215 Layer 3)
--     homeowner_contract_signed_email_sent   — docusign-webhook v49
--
--   (Task originally listed hubspot_contact_created and pre_flight_walk_complete;
--    investigation confirmed neither is written by an EF — premise corrected.)
--
-- DECISION RATIONALE (Path A — drop, not expand):
--   activity_log is an append-only audit/event log. A fail-closed CHECK that
--   every caller swallows is strictly worse than none — it loses audit data on
--   revenue-critical events with zero signal. An enumerated allow-list re-arms
--   the same trap on the next new event_type. Vocabulary hygiene, if wanted
--   later, will be a monitoring VIEW that flags unknown event_types — never a
--   blocking CHECK. (Companion change: the 3 EFs stop swallowing and report the
--   insert failure to Sentry, removing the blind spot. Tracked separately.)
--
-- CONSTRAINT BEING DROPPED (captured 2026-06-11 from pg_constraint):
--   CHECK (event_type = ANY (ARRAY[
--     'bid_submitted','bid_accepted','bid_rejected','opportunity_matched',
--     'profile_updated','settings_updated','contract_signed','job_completed']))
--
-- Forward-only side effects: none beyond removing the constraint. No table
-- rewrite; brief ACCESS EXCLUSIVE lock for the catalog update only.

BEGIN;

-- Safety net: assert the table exists and surface whether the target constraint
-- is present, so an unexpected schema state is loud rather than a silent no-op.
DO $$
DECLARE
  v_has_table BOOLEAN;
  v_has_constraint BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'activity_log'
  ) INTO v_has_table;

  IF NOT v_has_table THEN
    RAISE EXCEPTION 'Aborting v86: public.activity_log does not exist — unexpected schema state.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'activity_log_event_type_check'
      AND conrelid = 'public.activity_log'::regclass
  ) INTO v_has_constraint;

  IF v_has_constraint THEN
    RAISE NOTICE 'v86: dropping activity_log_event_type_check.';
  ELSE
    RAISE NOTICE 'v86: activity_log_event_type_check already absent — drop is a no-op (idempotent).';
  END IF;
END $$;

ALTER TABLE public.activity_log
  DROP CONSTRAINT IF EXISTS activity_log_event_type_check;

COMMIT;
