-- Migration: v53_switch_reason_survey
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-04-23T10:59:13Z, recorded in
-- supabase_migrations.schema_migrations as version 20260423105913, name
-- "v53_switch_reason_survey". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS switch_reason_survey JSONB;

COMMENT ON COLUMN claims.switch_reason_survey IS
  'D-171: Survey payload from homeowner switch request. Schema: { reasons: string[], notes: string, submitted_at: timestamptz }';
