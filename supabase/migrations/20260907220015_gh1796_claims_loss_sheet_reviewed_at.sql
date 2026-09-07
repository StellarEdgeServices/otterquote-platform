-- Migration: gh1796_claims_loss_sheet_reviewed_at
-- Issue: #1796 (sub-issue of #1653) — loss-sheet queue in admin homeowner tracking
-- Tier: 3A (additive, nullable, no default, no backfill, no constraint) per D-182 / D-261
-- Filed: 2026-09-07 (stamp.py: 2026-09-07T22:00:15Z)
-- Rollback: 20260907220015_gh1796_claims_loss_sheet_reviewed_at_rollback.sql
-- Pre-flight: 20260907220015_gh1796_claims_loss_sheet_reviewed_at_pre-flight.md
--
-- ⚠ STATUS: NOT APPLIED. Filed as a PR only. Nothing in this file has been run
-- against yeszghaspzwwstvsrioa or any branch. The Edge Functions that read the
-- column degrade gracefully until it exists (get-homeowner-list reports
-- loss_sheet_reviewed_column_present: false and shows every claim as unreviewed;
-- mark-loss-sheet-reviewed returns 503 migration_pending and writes nothing), so
-- merging the code ahead of the migration is safe and observable rather than a
-- silent 500.
--
-- WHY
-- Dustin's ruling on #1597, 2026-09-07, verbatim: "We are not changing our copy
-- regarding reviewing loss sheets to determine if it's acv or rcv. For now, I
-- want the system to identify people who need their loss sheets and bring them to
-- my attention in the administrative dashboard. This will need to be part of the
-- homeowner tracking process."
--
-- A queue of "loss sheets I still need to read" cannot exist without somewhere to
-- record "I have read this one". Nothing in the schema expressed that:
--   claims.loss_sheet_parsed_at  — the MACHINE parsed it (parse-loss-sheet EF)
--   claims.has_estimate          — a file was flagged as uploaded
--   claims.estimate_filename     — where that file lives in claim-documents
-- None of the three means a human looked at it. This column is that, and only
-- that. It is set exclusively by mark-loss-sheet-reviewed, from one admin button.
--
-- WHY A COLUMN AND NOT AN activity_log EVENT (#1796 offered either)
-- The repo's existing convention for "a human verified this record" is a nullable
-- timestamptz on the record: referral_agents.w9_verified_at,
-- contractors.coi_uploaded_at, quotes.warranty_uploaded_at,
-- claims.color_confirmed_at, claims.live_charge_authorized_at, and — on this same
-- concern — claims.loss_sheet_parsed_at. activity_log is the event STREAM, not
-- state: it has no per-claim uniqueness, its user_id is NOT NULL (so a claim with
-- a null user_id could carry no marker at all), and "is this claim reviewed"
-- would stop being expressible as a filter on claims. An activity_log row IS
-- written alongside the column by mark-loss-sheet-reviewed, exactly as
-- loss_sheet_parsed pairs with loss_sheet_parsed_at today.
--
-- SAFETY
-- Additive, nullable, no DEFAULT, no NOT NULL, no CHECK, no index, no trigger, no
-- backfill. Existing rows read NULL = "not reviewed", which is true of every row
-- today: this marker has never existed, so nothing has ever been marked. No
-- existing query, RLS policy, view or Edge Function references this name (grepped
-- across the tree at filing time — the only references are the ones added in this
-- same PR). ADD COLUMN with no default and no volatile expression is a catalog-only
-- change in PG 11+ — no table rewrite, no long lock on claims.

BEGIN;

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS loss_sheet_reviewed_at timestamptz;

COMMENT ON COLUMN public.claims.loss_sheet_reviewed_at IS
'gh-1796. When a platform admin marked this claim''s loss sheet as reviewed by a HUMAN, from the loss-sheet queue on admin-homeowners.html. NULL = not reviewed; the claim appears in that queue. Distinct from loss_sheet_parsed_at (the parse-loss-sheet EF read the PDF) and from has_estimate / estimate_filename (a file exists). Written only by the mark-loss-sheet-reviewed Edge Function, which also records an activity_log row (loss_sheet_reviewed / loss_sheet_review_cleared) as the audit trail. Never set by homeowner- or contractor-facing code, and carries no ACV/RCV determination — per Dustin''s ruling on #1597 the ACV/RCV review copy is unchanged.';

COMMIT;
