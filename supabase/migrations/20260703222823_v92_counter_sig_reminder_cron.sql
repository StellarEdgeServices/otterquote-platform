-- Migration: v92_counter_sig_reminder_cron
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-07-03T22:28:23Z, recorded in
-- supabase_migrations.schema_migrations as version 20260703222823, name
-- "v92_counter_sig_reminder_cron". NEVER RE-RUN.
--
-- PROVENANCE: sourced via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.
--
-- SECURITY NOTE: the statement as recorded in schema_migrations.statements
-- contains a hardcoded Supabase secret API key in the pg_cron net.http_post
-- Authorization header below -- the same class of finding as
-- 20260424210544_fix_notify_feature_request_webhook_key.sql and
-- 20260427162713_v59_incomplete_onboarding_reminders.sql from batch 1. That
-- value has been REDACTED here (replaced with [REDACTED-SECRET-KEY]) before
-- filing, to avoid committing a live-looking credential into git history.
-- This redaction changes only this repo file, not what already ran in
-- production or the live pg_cron job body. This session independently
-- confirmed via 20260812125540_v108_pg_cron_vault_secrets (not filed by
-- this batch -- excluded on the money-path keyword screen, and itself
-- containing the same plaintext key) that this exact key was later migrated
-- out of the counter-sig-reminders cron job into Supabase Vault. Rotation
-- of the key value itself was not independently verified by this batch.

INSERT INTO rate_limit_config (
  function_name, max_per_hour, max_per_day, max_per_month, enabled,
  monthly_cost_estimate, monthly_budget_cap, notes
) VALUES (
  'counter-sig-reminders', 3, 50, 1550, true, 0.00, 0.00,
  'D-149 counter-signature reminder cron — every 30 min via pg_cron. Sends Mailgun reminders to the contractor every 2 hours during business hours (8am–6pm contractor local time) until the contract is counter-signed. Rate limit is abuse guard — real cost is email volume (~$0 on Foundation plan). Caller ID is ''cron'' (function-level, not per-contractor).'
) ON CONFLICT (function_name) DO NOTHING;

SELECT cron.schedule(
  'counter-sig-reminders',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/counter-sig-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer [REDACTED-SECRET-KEY]'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);
