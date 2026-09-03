-- Migration: v59_incomplete_onboarding_reminders
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-04-27T16:27:13Z, recorded in
-- supabase_migrations.schema_migrations as version 20260427162713, name
-- "v59_incomplete_onboarding_reminders". NEVER RE-RUN.
--
-- PROVENANCE: sourced via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.
--
-- SECURITY NOTE (flagged in the gh-1438 batch-1 PR and evidence comment):
-- the statement as recorded in schema_migrations.statements contains the
-- SAME hardcoded Supabase secret API key seen in
-- 20260424210544_fix_notify_feature_request_webhook_key.sql, here in the
-- pg_cron net.http_post Authorization header below. That value has been
-- REDACTED here (replaced with [REDACTED-SECRET-KEY]) before filing, to
-- avoid committing a live-looking credential into git history. This
-- redaction changes only this repo file, not what already ran in
-- production or the live pg_cron job body. Whether this specific key is
-- still live was not verified by this batch -- flagged for the
-- CTO/owning engineer to confirm rotation status.

-- v59: Partial-completion onboarding reminder system
-- Adds column to track when a contractor received their 24hr incomplete-application nudge.
-- Also schedules the daily pg_cron job and adds rate_limit_config entry.

-- ── 1. Add partial_completion_email_sent_at to contractors ──────────────────
ALTER TABLE public.contractors
  ADD COLUMN IF NOT EXISTS partial_completion_email_sent_at TIMESTAMPTZ;

-- ── 2. rate_limit_config entry ──────────────────────────────────────────────
INSERT INTO public.rate_limit_config (
  function_name,
  max_per_hour,
  max_per_day,
  max_per_month,
  enabled,
  monthly_cost_estimate,
  monthly_budget_cap,
  notes
)
VALUES (
  'send-incomplete-onboarding-reminders',
  2,
  2,
  62,
  true,
  0.50,
  5.00,
  'Daily cron: nudges contractors stalled at onboarding_step=1 after 24h. 1 cron run + 1 manual test slot per day.'
)
ON CONFLICT (function_name) DO NOTHING;

-- ── 3. pg_cron schedule — daily at 2pm UTC (10am Eastern) ───────────────────
SELECT cron.schedule(
  'send-incomplete-onboarding-reminders',
  '0 14 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/send-incomplete-onboarding-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer [REDACTED-SECRET-KEY]'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);
