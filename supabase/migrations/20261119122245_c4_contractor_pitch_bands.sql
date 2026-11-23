-- STATUS (gh-1438, as of 2026-09-30T12:32Z): NOT APPLIED
-- FILE ROLE: forward file of set c4_contractor_pitch_bands (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: contractors.pitch_bands absent: comment 5494221280 (RW-DONE, PR #1471, supabase/migrations/MIGRATIONS-RECONCILIATION-1438.md Part 1, read-only queries 2026-09-01); comment 5850997376 (CLOSE-REVIEW 2026-09-26). Not re-measured since; re-query the live ledger before relying on it.
-- REPO COPY: none in supabase/migrations/ or supabase/migrations_rollbacks/ for this file
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- C4 — per-contractor priced slope bands
-- Tier 3A (purely additive: one nullable JSONB column, no constraint changes,
-- nothing dropped, renamed, retyped or narrowed, no existing row rewritten).
-- Drafted 2026-08-27. NOT APPLIED — every migration requires Dustin's approval.

alter table public.contractors
  add column if not exists pitch_bands jsonb;

comment on column public.contractors.pitch_bands is
  'C4: the contractor''s own priced roof-slope bands and access adders, as HIS rate '
  'card states them. Shape: {"source":"contractor_rate_card","bands":[{"label":..., '
  '"min_over_12":int|null,"max_over_12":int|null,"rate_per_square":numeric|null}], '
  '"two_story_adder":{"label":...,"rate_per_square":numeric}}. Pitch is expressed as '
  'rise over a run of 12. NULL means no rate card on file, and create-docusign-envelope '
  'falls back to the Xactimate-aligned 7/12 threshold. Deliberately NOT a platform '
  'constant: Indy Rooftops prices steep from 5/12 while Xactimate and RoofScope both '
  'use 7/12, and that is a commercial choice each contractor makes.';
