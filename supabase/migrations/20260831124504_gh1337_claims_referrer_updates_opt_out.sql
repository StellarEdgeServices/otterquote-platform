-- Migration: gh1337_claims_referrer_updates_opt_out
-- Filed by: gh-1438 migration reconciliation batch (Code lane)
-- Date filed: 2026-09-01
-- Original issue: #1337 (Tier 3A, additive, autonomous per D-261)
-- Rollback: supabase/migrations_rollbacks/20260831124504_gh1337_claims_referrer_updates_opt_out_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/20260831124504_gh1337_claims_referrer_updates_opt_out_pre-flight.md
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 reconciliation (issue #1438) — it does NOT re-apply anything;
-- merging this PR is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-31 (PR #1354), recorded in
-- supabase_migrations.schema_migrations as version 20260831124504,
-- name "gh1337_claims_referrer_updates_opt_out".
--
-- PROVENANCE: originally drafted as
-- supabase/migrations_drafts/gh1337_claims_referrer_updates_opt_out_forward.sql
-- (left in place, untouched, for the full annotated tri-state semantics
-- write-up — NULL/FALSE/TRUE — that draft documents). The SQL body below
-- is NOT byte-identical to that draft file: the applied statement (read
-- via a read-only query against supabase_migrations.schema_migrations.
-- statements for this version, 2026-09-01, gh-1438 reconciliation) is a
-- condensed re-write carrying a note that it was "applied from [the] full
-- annotated draft ... verbatim (semantics unchanged)". This file
-- reproduces that condensed, actually-applied text literally — it is the
-- literal record of what ran, not a retype of the fuller draft.

BEGIN;

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS referrer_updates_opt_out BOOLEAN;

COMMENT ON COLUMN public.claims.referrer_updates_opt_out IS
'gh-1337: homeowner''s choice on the intake opt-out checkbox for progress updates sent to the person who referred them. TRUE = opted out (do not send). FALSE = shown the checkbox and did not opt out (the ONLY value that permits a send). NULL = never asked (do not send). Read by send-partner-status-email; copy approved by Dustin on gh-1336, R-120.';

COMMIT;
