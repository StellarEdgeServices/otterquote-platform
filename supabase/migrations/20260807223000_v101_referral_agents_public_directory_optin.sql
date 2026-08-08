-- Migration: v101_referral_agents_public_directory_optin
-- Author: Code (Claude Code), Wave 2 weekend engineering-drain batch 1
-- Date: 2026-08-07
-- Issue: StellarEdgeServices/otterquote-platform#402
-- Tier: 3A (additive boolean column, NOT NULL DEFAULT false) per R-097/D-261 label on the issue
-- Rollback: 20260807223000_v101_referral_agents_public_directory_optin_rollback.sql
-- Pre-flight: 20260807223000_v101_referral_agents_public_directory_optin_pre-flight.md
--
-- STATUS: PR ONLY — NOT APPLIED. This file has not been run against the live
-- database by the authoring session. Applying it to production is a separate,
-- later step for a human/migration-author review, per this batch's constraints.
--
-- PROVENANCE NOTE: This is a re-cut, timestamp-prefixed, applyable version of
-- the untimestamped draft supasbase/migrations/v88_referral_agents_public_directory_optin.sql
-- (merged 2026-07-03 via PR #367, session rw-86e1h5j3x-f22-a015, ClickUp 86e1h5j3x).
-- That draft file was deliberately left without a timestamp prefix, so the
-- Supabase migration tooling never picked it up — it is inert, documentation-only.
-- The SQL below is unchanged from that draft. It is renumbered v101 (rather than
-- reusing "v88") because the v88 label has since been used twice more in the
-- applied lineage (v88_referral_agents_public_view, v88_contractor_claim_docs_read)
-- and the applied sequence is now at v100 as of 2026-08-05. The original v88 draft
-- files are left in place untouched for historical record; do not delete them
-- without also confirming this file superseded them.
--
-- Summary: Adds public_directory_optin boolean column to public.referral_agents.
--          Agents default to NOT opted in (false). Purely additive — no existing
--          rows are altered beyond receiving the new default value, no data loss.
--
-- Target table confirmed via live-DB read-only check (2026-08-07):
--   public.referral_agents had exactly 2 rows as of the issue's filing date
--   (2026-07-05) — matching the "(2-row table)" description in issue #402's
--   title — and has since grown to 9 rows via legitimate self-serve partner
--   registrations (register_partner RPC, shipped 2026-07-25, v95/v95a).
--   Schema already carries directory-facing columns (bio, photo_url, website,
--   service_area), consistent with gating a public partner directory listing.

BEGIN;

ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS public_directory_optin BOOLEAN NOT NULL DEFAULT false;

COMMIT;
