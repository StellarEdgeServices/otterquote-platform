-- STATUS (gh-1438, as of 2026-11-18T20:26:39Z): NOT APPLIED
-- FILE ROLE: rollback file of set c4_contractor_pitch_bands_guard (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: see c4_contractor_pitch_bands_guard.sql; no database was read or written to produce this file.
-- REPO COPY: none in supabase/migrations/ or supabase/migrations_rollbacks/ for this file
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback for c4_contractor_pitch_bands_guard.sql. Run BEFORE c4_contractor_pitch_bands_rollback.sql (which drops the column).
-- Removing the trigger re-opens client writes to contractors.pitch_bands; the render-side validator in create-docusign-envelope still
-- falls back to the default bands on malformed JSON.
alter table public.contractors drop constraint if exists contractors_pitch_bands_shape_chk;
drop trigger if exists contractors_pin_pitch_bands on public.contractors;
drop function if exists public.contractors_pin_pitch_bands();
