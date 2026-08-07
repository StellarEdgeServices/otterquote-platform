-- Migration: v83_add_public_directory_optin_to_contractors
-- Author: Wingman F-22 (automated)
-- Date: 2026-05-26
-- D-numbers: D-182 (deploy tier 3), D-221 (path A deploy)
-- Rollback: v83_add_public_directory_optin_to_contractors_rollback.sql
-- Pre-flight: v83_add_public_directory_optin_to_contractors_pre-flight.md
-- ClickUp task: 86e1j4jaz (SEO P2 — public contractor directory)
--
-- Summary: Adds public_directory_optin boolean column to contractors table.
--          Contractors default to NOT opted in (false). Future SEO directory
--          page will show only contractors where this flag is true.

BEGIN;

ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS public_directory_optin BOOLEAN DEFAULT false NOT NULL;

COMMIT;
