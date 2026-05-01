-- v68: Add completion_date to claims table
-- Enables contractor-initiated job completion via mark-job-complete Edge Function
-- LAUNCH-BLOCKER — ClickUp 86e0yvj7b
-- Session: W2-P1, May 1, 2026
-- Companion rollback: sql/v68-rollback-claims-completion-date.sql

-- Add completion_date column to claims
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS completion_date TIMESTAMPTZ NULL;

-- Partial index for rebate queries: process-hover-rebate scans claims where
-- job is complete but rebate hasn't been paid yet
CREATE INDEX IF NOT EXISTS idx_claims_completion_date
  ON public.claims (completion_date)
  WHERE completion_date IS NOT NULL;

-- Extend activity_log event_type CHECK constraint to include 'job_completed'
-- Must drop and recreate — PostgreSQL does not support ADD VALUE to CHECK constraints
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
