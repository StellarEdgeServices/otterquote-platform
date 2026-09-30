-- STATUS (gh-1438, as of 2026-09-30T12:32Z): NOT APPLIED (this file's SQL). SUPERSEDED: referral_agents.public_directory_optin is live via v101
-- FILE ROLE: forward file of set v88_referral_agents_public_directory_optin (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: column live via v101_referral_agents_public_directory_optin, ledger version 20260808134406 (the 20260807223000 filename is not a ledger version): comment 5494221280 (RW-DONE, PR #1471, supabase/migrations/MIGRATIONS-RECONCILIATION-1438.md Part 1, read-only queries 2026-09-01); ledger version 20260808134406 is in the 199-row schema_migrations snapshot recorded in supabase/migrations-reconciliation-baseline.json (queried 2026-09-29T20:55Z; comments 5902170993, 5902404090)
-- REPO COPY: supabase/migrations/20260808134406_v101_referral_agents_public_directory_optin.sql -- DIFFERS in SQL statements (comment/whitespace-normalised compare, this session)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- >>> SUPERSEDED (2026-09-26, gh-1438 part 2; pointer corrected round 2) --
-- referral_agents.public_directory_optin IS live in production, but this
-- file is NOT what added it. It was added by a different, already-
-- reconciled migration: supabase/migrations/20260808134406_v101_referral_agents_public_directory_optin.sql
-- (version 20260808134406, issue #385). NOTE: an earlier version of this
-- banner pointed to supabase/migrations/20260807223000_v101_...sql --
-- 20260807223000 is NOT a recorded ledger version (confirmed read-only
-- this session); it is a Direction-2 duplicate, named as such in
-- MIGRATIONS-RECONCILIATION-1438.md's Remainder section, not a valid
-- pointer target. Applying THIS file now would attempt to add the same
-- column a second time. Kept here, unmodified below this banner, for
-- history only. <<<
-- Migration: v88_referral_agents_public_directory_optin
-- Author: run-work F-22 sub-agent (automated) — session rw-86e1h5j3x-f22-a015
-- Date: 2026-07-03
-- Status: DRAFT ONLY — DO NOT APPLY. Tier 3 (D-182) approval pending.
-- D-numbers: D-182 (deploy tier 3), D-221 (path A deploy)
-- Rollback: v88_referral_agents_public_directory_optin_rollback.sql
-- Pre-flight: v88_referral_agents_public_directory_optin_pre-flight.md
-- ClickUp task: 86e1h5j3x (SEO P2 — /partners/ referral-partner directory)
--
-- NUMBERING NOTE: sql/v88-referral-agents-public-view.sql (2026-06-13) also
-- carries the v88 label in the legacy sql/ lineage. This file follows the
-- supabase/migrations/ lineage (v83..v87). Orchestrator: renumber to v89 at
-- approval time if the two lineages have since been unified.
--
-- Summary: Adds public_directory_optin boolean column to referral_agents.
--          Agents default to NOT opted in (false). The partner directory
--          generator (tools/generate_partner_pages.py) renders pages only
--          for agents where this flag is true — zero pages until this
--          migration is applied AND agents explicitly opt in.

BEGIN;

ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS public_directory_optin BOOLEAN NOT NULL DEFAULT false;

COMMIT;
