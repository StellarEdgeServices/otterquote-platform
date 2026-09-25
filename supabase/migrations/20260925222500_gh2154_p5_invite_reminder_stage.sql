-- gh-2154 P-5 go-live round (Ben, bus 2026-09-25T22:17:42Z item 2): the
-- Meta-invite 48h reminder email reuses P-4's own partner_onboarding_sends
-- idempotency ledger and claim_partner_onboarding_stage() atomic claim --
-- deliberately NOT a new table/function -- so it inherits, for free, every
-- hardening #2191 already landed on prod: at-most-one-claim-in-flight
-- (INSERT ... ON CONFLICT ... DO UPDATE WHERE), a 'pending' row is NEVER
-- reclaimed (surfaced as uncertain instead of risking a double-send), and
-- a 'failed' row is retried only under the same attempt_count < 5 AND NOT
-- terminal_failure cap.
--
-- The ONLY change needed: partner_onboarding_sends.stage's CHECK
-- constraint (live today: stage = ANY ('day0','day1','day3','day7'),
-- confirmed by a read-only probe against prod, conname
-- partner_onboarding_sends_stage_check) does not yet allow a fifth value.
-- This migration widens it, additively, to also allow 'invite_reminder' --
-- the stage supabase/functions/send-partner-invite-reminder/ claims via
-- the EXACT SAME claim_partner_onboarding_stage(id, 'invite_reminder')
-- call P-4 uses for its own four stages. onboarding-stage.ts's selectStage
-- (P-4's own day0-7 sequencer) is UNAFFECTED: it only ever looks up the
-- four OnboardingStage keys ("day0"/"day1"/"day3"/"day7") in the priorRecords
-- map run-sweep.ts builds from this same table; an extra 'invite_reminder'
-- row for the same partner_id is simply never a key it queries.
--
-- No other object changes. claim_partner_onboarding_stage()'s signature,
-- body, SECURITY DEFINER, search_path and REVOKEs are all already correct
-- for a generic stage string and untouched by this migration.
--
-- APPLY-BEFORE-MERGE, with a read-back, per this PR's go-live order.
--
-- ROLLBACK: see
-- supabase/migrations_rollbacks/20260925222500_gh2154_p5_invite_reminder_stage_rollback.sql
-- -- restores the CHECK to its exact live 4-value form. Safe: dropping the
-- 5th allowed value back out only matters if an 'invite_reminder' row
-- already exists, which the rollback also handles (see that file).

BEGIN;

ALTER TABLE public.partner_onboarding_sends
  DROP CONSTRAINT partner_onboarding_sends_stage_check;

ALTER TABLE public.partner_onboarding_sends
  ADD CONSTRAINT partner_onboarding_sends_stage_check
  CHECK (stage = ANY (ARRAY['day0'::text, 'day1'::text, 'day3'::text, 'day7'::text, 'invite_reminder'::text]));

COMMENT ON COLUMN public.partner_onboarding_sends.stage IS
'gh-2154 P-4/P-5: which send this row tracks. day0/day1/day3/day7 are send-partner-onboarding''s sequence (onboarding-stage.ts''s STAGE_ORDER); invite_reminder is send-partner-invite-reminder''s single 48h Meta-lead-invite reminder (gh-2154 P-5, #2182). Same ledger, same claim_partner_onboarding_stage() atomic claim, same retry-cap/uncertain-alert hardening (#2191) for both.';

COMMIT;
