-- Migration: v55_hover_material_list
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-04-23T18:24:41Z, recorded in
-- supabase_migrations.schema_migrations as version 20260423182441, name
-- "v55_hover_material_list". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.
--
-- NOTE: a second, separate applied migration also named
-- "v55_hover_material_list" exists at version 20260423231652 (filed
-- alongside this one in the same batch) -- both are real, distinct rows
-- in schema_migrations; this is not a duplicate filing.

-- v55: Persist Hover material_list to hover_orders at D-164 gate release
-- Decision locked April 22, 2026 (Session 342) — ClickUp 86e116rb8

ALTER TABLE hover_orders ADD COLUMN IF NOT EXISTS material_list JSONB;

CREATE INDEX IF NOT EXISTS hover_orders_material_list_idx
  ON hover_orders USING gin(material_list)
  WHERE material_list IS NOT NULL;
