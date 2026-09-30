-- STATUS (gh-1438, as of 2026-09-30T12:32Z): NOT APPLIED (this file's SQL). SUPERSEDED: referral_agents.public_directory_optin is live via v101
-- FILE ROLE: rollback file of set v88_referral_agents_public_directory_optin (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: column live via v101_referral_agents_public_directory_optin, ledger version 20260808134406 (the 20260807223000 filename is not a ledger version): comment 5494221280 (RW-DONE, PR #1471, supabase/migrations/MIGRATIONS-RECONCILIATION-1438.md Part 1, read-only queries 2026-09-01); ledger version 20260808134406 is in the 199-row schema_migrations snapshot recorded in supabase/migrations-reconciliation-baseline.json (queried 2026-09-29T20:55Z; comments 5902170993, 5902404090)
-- REPO COPY: supabase/migrations_rollbacks/20260807223000_v101_referral_agents_public_directory_optin_rollback.sql -- same SQL statements (differs only in comments/blank lines/BEGIN/COMMIT/whitespace)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- >>> SUPERSEDED (2026-09-26, gh-1438 part 2) -- the object this rollback
-- would touch is not live under this migration's own name; the live column
-- was added by supabase/migrations/20260808134406_v101_referral_agents_public_directory_optin.sql
-- instead (issue #385). This rollback pairs with the SUPERSEDED forward
-- file and should not be run. Kept here, unmodified below this banner, for
-- history. <<<
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
