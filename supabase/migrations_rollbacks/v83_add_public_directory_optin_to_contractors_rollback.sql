-- Rollback: v83_add_public_directory_optin_to_contractors_rollback.sql
-- Reverts: v83_add_public_directory_optin_to_contractors.sql
-- Author: Wingman F-22 (automated)
-- Date: 2026-05-26
-- WARNING: Only run this if the forward migration needs to be undone in production.
--          Dropping this column destroys any optin data that has been recorded.
--          Verify no production writes have occurred before executing.

BEGIN;

ALTER TABLE contractors
  DROP COLUMN IF EXISTS public_directory_optin;

COMMIT;
