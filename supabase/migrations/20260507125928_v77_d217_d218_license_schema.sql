-- Migration: v77_d217_d218_license_schema
-- Filed by: gh-1438 migration history backfill batch 2 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 2, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-07T12:59:28Z, recorded in
-- supabase_migrations.schema_migrations as version 20260507125928, name
-- "v77_d217_d218_license_schema". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 2. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

ALTER TABLE public.contractor_licenses
  ADD COLUMN jurisdiction_level TEXT NOT NULL
    CHECK (jurisdiction_level IN ('state', 'county', 'city', 'other'));

ALTER TABLE public.contractor_licenses
  ADD COLUMN verification_url TEXT NULL;

ALTER TABLE public.contractors
  ADD CONSTRAINT chk_contractors_license_path
  CHECK (license_path IS NULL OR license_path = 'not_provided');
