-- Rollback: v88_referral_agents_public_directory_optin_rollback.sql
-- Reverts: v88_referral_agents_public_directory_optin.sql
-- Author: run-work F-22 sub-agent (automated) — session rw-86e1h5j3x-f22-a015
-- Date: 2026-07-03
-- Status: DRAFT ONLY — forward migration not yet applied (D-182 approval pending).
-- WARNING: Only run this if the forward migration needs to be undone in production.
--          Dropping this column destroys any opt-in data that has been recorded.
--          Verify no production writes have occurred before executing.

BEGIN;

ALTER TABLE public.referral_agents
  DROP COLUMN IF EXISTS public_directory_optin;

COMMIT;
