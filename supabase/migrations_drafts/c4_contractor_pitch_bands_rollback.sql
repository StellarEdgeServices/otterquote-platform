-- STATUS (gh-1438, as of 2026-09-30T12:32Z): NOT APPLIED
-- FILE ROLE: rollback file of set c4_contractor_pitch_bands (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: contractors.pitch_bands absent: comment 5494221280 (RW-DONE, PR #1471, supabase/migrations/MIGRATIONS-RECONCILIATION-1438.md Part 1, read-only queries 2026-09-01); comment 5850997376 (CLOSE-REVIEW 2026-09-26). Not re-measured since; re-query the live ledger before relying on it.
-- REPO COPY: none in supabase/migrations/ or supabase/migrations_rollbacks/ for this file
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback for c4_contractor_pitch_bands.sql
-- Safe because the column is additive and nullable: no other object depends on
-- it, and create-docusign-envelope reads it with `?.` and falls back when absent.
-- Dropping it loses any rate cards entered after the forward migration — export
-- `select id, pitch_bands from public.contractors where pitch_bands is not null`
-- before running this if any are populated.

alter table public.contractors
  drop column if exists pitch_bands;
