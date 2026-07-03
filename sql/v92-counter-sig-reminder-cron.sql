-- ============================================================
-- v92: D-149 — counter-signature reminder cron + rate limit config
--      (ClickUp 86e1gabf4)
-- Applied: (pending — applied by orchestrator after PR merge)
--
-- Context:
--   docusign-webhook now sends the contractor an immediate Mailgun
--   nudge when the homeowner signs and inserts a pending marker
--   into the notifications table. The Edge Function
--   counter-sig-reminders drains those markers, sending follow-up
--   reminders every 2 hours during business hours (8am–6pm
--   contractor local time) until the contractor counter-signs.
--   This migration registers the pg_cron schedule (every 30 min)
--   and the rate_limit_config entry for the function. No table or
--   column changes — the cadence state lives in notifications rows.
--
-- What this migration does:
--   1. Inserts a rate_limit_config row for counter-sig-reminders
--      (3/hour max — 2 cron ticks + 1 manual test slot per hour).
--   2. Schedules counter-sig-reminders via pg_cron at */30 * * * *
--      (every 30 minutes). The EF internally gates to at most one
--      reminder per contract per 2-hour window.
--
-- Safe to re-run:
--   INSERT uses ON CONFLICT DO NOTHING for rate_limit_config.
--   cron.schedule() is upsert-safe: if the named job already
--   exists it updates the schedule rather than erroring.
--
-- Rollback: sql/v92r-counter-sig-reminder-cron-rollback.sql
-- ============================================================

-- ── 1. Rate limit config entry ──────────────────────────────

INSERT INTO rate_limit_config (
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
  'counter-sig-reminders',
  3,         -- max 3 runs/hour (cron is 2/hour; allows 1 manual test trigger)
  50,        -- max 50 runs/day (48 cron + 2 manual slots for dev/testing)
  1550,      -- max 1550 runs/month (~50/day safety margin over 31 days)
  true,
  0.00,      -- Mailgun included in $35/mo Foundation plan (50K emails/month)
  0.00,
  'D-149 counter-signature reminder cron — every 30 min via pg_cron. '
  'Sends Mailgun reminders to the contractor every 2 hours during business '
  'hours (8am–6pm contractor local time) until the contract is '
  'counter-signed. Rate limit is abuse guard — real cost is email volume '
  '(~$0 on Foundation plan). Caller ID is ''cron'' (function-level, not '
  'per-contractor).'
)
ON CONFLICT (function_name) DO NOTHING;

-- ── 2. pg_cron job — every 30 minutes ───────────────────────
-- Uses net.http_post (pg_net extension) to call the Edge Function.
-- Service role key is read from Supabase secrets at runtime via
-- the Edge Function; the cron job itself passes the service role
-- bearer token so the function receives it as Authorization header.
--
-- NOTE: Replace SUPABASE_SERVICE_ROLE_KEY below with the actual
-- secret value if running this migration manually via Management API.
-- The secret is: [REDACTED — retrieve from Supabase Edge Function Secrets]
--
-- The cron.schedule() function is idempotent: if a job named
-- 'counter-sig-reminders' already exists, it updates the schedule.

SELECT cron.schedule(
  'counter-sig-reminders',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/counter-sig-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer [SUPABASE_SERVICE_ROLE_KEY]'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);
