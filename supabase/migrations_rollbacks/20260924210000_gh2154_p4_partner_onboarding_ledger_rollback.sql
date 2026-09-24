-- ============================================================================
-- gh-2154 P-4 ROLLBACK: drop the partner onboarding idempotency ledger
-- ============================================================================
-- Safe: nothing else references public.partner_onboarding_sends. The Edge
-- Function that writes to it (send-partner-onboarding) ships with its kill
-- switch OFF by default and is deployed/undeployed independently of this
-- migration.

BEGIN;

DROP TABLE IF EXISTS public.partner_onboarding_sends;

COMMIT;
