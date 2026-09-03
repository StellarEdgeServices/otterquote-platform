-- Migration: v71_warranty_indexes
-- Filed by: gh-1438 migration history backfill batch 2 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 2, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-03T03:39:47Z, recorded in
-- supabase_migrations.schema_migrations as version 20260503033947, name
-- "v71_warranty_indexes". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 2. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- Migration v71: Add indexes for warranty fields
-- Supports homeowner warranty document lookup and contractor warranty upload prompt
-- Applied: 2026-05-02

-- Index 1 (quotes): Homeowner dashboard — "show me my warranty document"
CREATE INDEX idx_quotes_warranty_claim
  ON public.quotes (claim_id, warranty_uploaded_at)
  WHERE warranty_uploaded_at IS NOT NULL;

-- Index 2 (claims): Contractor dashboard — "Upload Warranty" prompt list
-- completion_date lives on claims (set by mark-job-complete edge function).
CREATE INDEX idx_claims_contractor_completed
  ON public.claims (selected_contractor_id, completion_date)
  WHERE completion_date IS NOT NULL;
