-- Migration: v70_quotes_warranty_document_url
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-01T22:02:56Z, recorded in
-- supabase_migrations.schema_migrations as version 20260501220256, name
-- "v70_quotes_warranty_document_url". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS warranty_document_url TEXT        NULL,
  ADD COLUMN IF NOT EXISTS warranty_uploaded_at  TIMESTAMPTZ NULL;

COMMENT ON COLUMN quotes.warranty_document_url IS
  'Storage path in contractor-documents bucket for the warranty PDF. '
  'Format: contractor-documents/warranties/{quote_id}/{timestamp}-{filename}.pdf. '
  'NULL until contractor uploads. Replacement updates in place; full history in activity_log.';

COMMENT ON COLUMN quotes.warranty_uploaded_at IS
  'Timestamp of the most recent warranty upload. Replacement updates this in place.';
