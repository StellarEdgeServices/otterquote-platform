-- ============================================================================
-- v114 — pg_cron schedule + rate_limit_config for watch-template-mapping
-- (gh-1313 closes-on (a) — the manual_mapping_pending watcher)
-- ============================================================================
--
-- CONTEXT
--   validate-contract-template sets contractor_templates.status =
--   'manual_mapping_pending' when a contractor's PDF lacks required D-199
--   markers, and nothing else happens: no activity_log row, no notify, no
--   platform_alerts_log row. A row entered that state on 2026-08-21 and sat
--   there unwatched for two weeks (gh-1313, CTO RUN 22 read). The same is
--   true of 'pending_validation' (uploaded, never validated) and
--   'submitted_for_admin_review' (D-199 Tier 3, waiting on the admin).
--
--   supabase/functions/watch-template-mapping/index.ts scans those three
--   statuses, keeps rows older than 24h (TEMPLATE_WATCH_THRESHOLD_HOURS),
--   writes ONE platform_alerts_log row per template per rolling 24h
--   (alert_type 'template_stuck'), and returns the list as JSON. Email to
--   the admin is behind TEMPLATE_WATCH_EMAIL_ENABLED=true and is OFF by
--   default — with the flag unset this job writes alert rows only, which
--   admin-template-review.html surfaces by age.
--
-- STATUS: PROPOSED. Not executed against production by the branch that
--   adds it. Tier 3A (additive: one cron job + one rate_limit_config row; no
--   DDL, no RLS, no external side effect while the email flag is off).
--   Apply order: deploy the Edge Function FIRST, then run this file — the
--   cron tick 404s harmlessly otherwise, but there is no reason to schedule
--   a function that does not exist yet.
--
-- AUTH PATTERN: identical to v113 (send-homeowner-next-steps) — the
--   existing 'cron_service_role_key' Vault secret (v108, gh-688) via
--   vault.decrypted_secrets. The function's Authorization gate accepts a
--   service-role Bearer (index.ts "Authorization" branch); no new secret.
--
-- Cadence: hourly at :20 (offset from the :00 crowd — process-bid-
--   expirations and home-profile-prompt-hourly both fire at :00). The
--   threshold is 24h and the dedup window is 24h, so hourly is plenty:
--   a template is reported within an hour of crossing 24h, then once a day.
--
-- Idempotent: rate_limit_config insert is ON CONFLICT DO NOTHING;
--   cron.schedule() upserts by jobname, so re-running this file is safe.
--
-- Rollback: v114-rollback-watch-template-mapping-cron.sql
--   (cron.unschedule + delete the rate_limit_config row).
-- ============================================================================

-- 1. rate_limit_config entry (registry row — the function sends nothing
--    unless TEMPLATE_WATCH_EMAIL_ENABLED=true; these caps are an abuse guard
--    for manual triggers, not a cost model).
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
  'watch-template-mapping',
  4,
  48,
  1000,
  true,
  0.00,
  1.00,
  'gh-1313: hourly cron. Reports contractor_templates rows sitting in manual_mapping_pending / pending_validation / submitted_for_admin_review for > 24h to platform_alerts_log (alert_type template_stuck, one row per template per 24h). Admin email only when TEMPLATE_WATCH_EMAIL_ENABLED=true (default off).'
)
ON CONFLICT (function_name) DO NOTHING;

-- 2. pg_cron schedule — hourly at :20, vault-backed service-role auth.
SELECT cron.schedule(
  'watch-template-mapping',
  '20 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/watch-template-mapping',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);
