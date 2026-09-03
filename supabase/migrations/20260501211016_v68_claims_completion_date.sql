-- Migration: v68_claims_completion_date
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-01T21:10:16Z, recorded in
-- supabase_migrations.schema_migrations as version 20260501211016, name
-- "v68_claims_completion_date". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v68: Add completion_date to claims table
-- Enables contractor-initiated job completion via mark-job-complete Edge Function
-- LAUNCH-BLOCKER — ClickUp 86e0yvj7b
-- Session: W2-P1, May 1, 2026

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS completion_date TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_claims_completion_date
  ON public.claims (completion_date)
  WHERE completion_date IS NOT NULL;

ALTER TABLE public.activity_log
  DROP CONSTRAINT IF EXISTS activity_log_event_type_check;

ALTER TABLE public.activity_log
  ADD CONSTRAINT activity_log_event_type_check CHECK (
    event_type IN (
      'bid_submitted',
      'bid_accepted',
      'bid_rejected',
      'opportunity_matched',
      'profile_updated',
      'settings_updated',
      'contract_signed',
      'job_completed'
    )
  );
