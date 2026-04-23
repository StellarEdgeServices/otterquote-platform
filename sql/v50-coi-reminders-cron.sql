-- ============================================================
-- v50: D-170 — COI nightly reminder cron job + rate limit config
-- Applied: (pending)
--
-- Context:
--   SQL v46 added the COI reminder timestamp columns to the
--   contractors table. The Edge Function process-coi-reminders
--   sends 30/14/7-day Mailgun reminders and suspends contractors
--   on expiry. This migration registers the pg_cron schedule
--   (8am daily) and the rate_limit_config entry for the function.
--
-- What this migration does:
--   1. Inserts a rate_limit_config row for process-coi-reminders
--      (2/day max — daily cron + 3 manual test slots per day).
--   2. Schedules process-coi-reminders via pg_cron at 0 8 * * *
--      (8:00 AM UTC daily).
--
-- Safe to re-run:
--   INSERT uses ON CONFLICT DO NOTHING for rate_limit_config.
--   cron.schedule() is upsert-safe: if the named job already
--   exists it updates the schedule rather than erroring.
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
  'process-coi-reminders',
  2,         -- max 2 runs/hour (cron is 1/day; allows manual test triggers)
  5,         -- max 5 runs/day (1 cron + 4 manual slots for dev/testing)
  62,        -- max 62 runs/month (~2/day safety margin over 31 days)
  true,
  0.00,      -- Mailgun included in $35/mo Foundation plan (50K emails/month)
  0.00,
  'D-170 COI expiry reminder cron — 8am UTC daily via pg_cron. '
  'Sends Mailgun reminders at 30/14/7 days before COI expiry; '
  'suspends contractor on expiry day. Rate limit is abuse guard — '
  'real cost is email volume (~$0 on Foundation plan). '
  'Caller ID is ''cron'' (function-level, not per-contractor).'
)
ON CONFLICT (function_name) DO NOTHING;

-- ── 2. pg_cron job — 8:00 AM UTC daily ─────────────────────
-- Uses net.http_post (pg_net extension) to call the Edge Function.
-- Service role key is read from Supabase secrets at runtime via
-- the Edge Function; the cron job itself passes the service role
-- bearer token so the function receives it as Authorization header.
--
-- NOTE: Replace SUPABASE_SERVICE_ROLE_KEY below with the actual
-- secret value if running this migration manually via Management API.
-- The secret is: [REDACTED — retrieve from Supabase Edge Function Secrets]
-- (already known to be current as of Session 288).
--
-- The cron.schedule() function is idempotent: if a job named
-- 'process-coi-reminders' already exists, it updates the schedule.

SELECT cron.schedule(
  'process-coi-reminders',
  '0 8 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-coi-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer [SUPABASE_SERVICE_ROLE_KEY]'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);
