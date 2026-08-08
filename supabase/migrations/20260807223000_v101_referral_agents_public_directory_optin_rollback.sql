-- Rollback: 20260807223000_v101_referral_agents_public_directory_optin_rollback.sql
-- Reverts: 20260807223000_v101_referral_agents_public_directory_optin.sql
-- Issue: StellarEdgeServices/otterquote-platform#402
-- Date: 2026-08-07
-- Status: PR ONLY — forward migration not applied. Only run this rollback if the
--         forward migration has already been applied to production and needs to
--         be undone.
-- WARNING: Dropping this column destroys any opt-in data recorded after the
--          forward migration runs. Verify no production writes have occurred
--          (or that the loss is acceptable) before executing.

BEGIN;

ALTER TABLE public.referral_agents
  DROP COLUMN IF EXISTS public_directory_optin;

COMMIT;
