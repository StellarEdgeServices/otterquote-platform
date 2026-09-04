-- Migration: v82_drop_orphaned_tables
-- Filed by: gh-1438 migration history backfill batch 2 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 2, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-27T19:42:24Z, recorded in
-- supabase_migrations.schema_migrations as version 20260527194224, name
-- "v82_drop_orphaned_tables". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 2. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v82: Drop 4 orphaned Phase 2 scaffolding tables
-- Verified 2026-05-26 (ARCHITECT tasks 86e1fwddx + 86e1fwdh2):
--   0 rows, 0 JS/TS/HTML references on all four tables
-- CTO ruling 2026-05-26: safe to drop. ClickUp: 86e1jkar2

DROP TABLE IF EXISTS claim_trade_items;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS inspection_bookings;
DROP TABLE IF EXISTS job_assignments;
