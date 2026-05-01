-- ROLLBACK v68: Remove completion_date from claims, restore original event_type constraint
-- Execute AFTER reverting the mark-job-complete Edge Function deploy
-- LAUNCH-BLOCKER — ClickUp 86e0yvj7b
-- Session: W2-P1, May 1, 2026

-- Remove partial index first (required before column drop)
DROP INDEX IF EXISTS public.idx_claims_completion_date;

-- Remove completion_date column
ALTER TABLE public.claims
  DROP COLUMN IF EXISTS completion_date;

-- Restore original activity_log event_type constraint (without 'job_completed')
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
      'contract_signed'
    )
  );
