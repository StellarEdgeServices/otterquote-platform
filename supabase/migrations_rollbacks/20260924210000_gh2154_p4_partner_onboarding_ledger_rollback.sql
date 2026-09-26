-- ============================================================================
-- gh-2154 P-4 ROLLBACK: drop the partner onboarding idempotency ledger,
-- its atomic-claim function, and the opt-out column (Kevin corrections
-- Q1/Q3)
-- ============================================================================
-- Safe: nothing else references public.partner_onboarding_sends,
-- public.claim_partner_onboarding_stage(), or
-- public.referral_agents.onboarding_opted_out_at. The Edge Functions that
-- write to them (send-partner-onboarding, partner-email-optout) ship with
-- the kill switch OFF by default and are deployed/undeployed independently
-- of this migration.

BEGIN;

DROP FUNCTION IF EXISTS public.claim_partner_onboarding_stage(uuid, text, integer);

DROP TABLE IF EXISTS public.partner_onboarding_sends;

ALTER TABLE public.referral_agents
  DROP COLUMN IF EXISTS onboarding_opted_out_at;

COMMIT;
