-- ============================================================================
-- v113 — pg_cron schedule + rate_limit_config for send-homeowner-next-steps
-- (gh-1580, Tier 3 / D-182 — PROPOSED, NOT YET APPLIED)
-- ============================================================================
--
-- CONTEXT
--   gh-1580: real homeowners who sign up and go silent (ready_for_bids=false,
--   has_measurements=false, no hover_orders row, no activity_log row since
--   signup) receive no email and Dustin sees nothing (gh-1570 gate read).
--   supabase/functions/send-homeowner-next-steps/index.ts implements the
--   batch scan + day-0 (+2h) / day-2 (+48h) nudge send; this file wires it
--   to pg_cron so it actually runs.
--
-- STATUS: PROPOSED. This file has NOT been executed against production. Per
--   the migration-author-code protocol, every migration here is Tier 3 /
--   D-182 and requires Dustin's explicit approval before apply — this PR
--   does not self-apply it. Applying this (Supabase MCP apply_migration,
--   project yeszghaspzwwstvsrioa) is the concrete next step after merge,
--   and is what makes the gh-1580 closes-on artifact observable (a live
--   is_test=false signup won't get a nudge, and admin-dashboard.html's NEW
--   strip is populated by get-business-lines-dashboard regardless of cron
--   status, but the EMAIL half of the closes-on needs this cron running).
--
-- AUTH PATTERN: reuses the existing 'cron_service_role_key' Vault secret
--   (created by v108, gh-688) via vault.decrypted_secrets rather than
--   embedding a new plaintext secret in cron.job.command — the send-
--   homeowner-next-steps function's Authorization gate already accepts a
--   service-role Bearer token (see index.ts "Authorization" branch), so no
--   new CRON_SECRET env var or vault entry is needed. (Note for the CTO/
--   security owner, found in passing while writing this: at least one
--   existing job — home-profile-prompt-hourly — still carries its
--   X-Cron-Secret value in cron.job.command as live plaintext, readable by
--   anyone with cron schema catalog access; it predates and was out of
--   scope for v108. Flagging, not fixing, here — out of scope for gh-1580.)
--
-- Cadence: every 30 minutes, matching counter-sig-reminders / check-siding-
--   design-completion / process-dunning-cron — tight enough that the +2h
--   and +48h gates fire within 30 min of the mark without being a hot loop
--   (the function's own scan LIMIT 200 and per-claim idempotency stamp make
--   re-running on a stale queue a cheap no-op).
--
-- Idempotent: rate_limit_config insert is ON CONFLICT DO NOTHING;
--   cron.schedule() upserts by jobname, so re-running this file is safe.
--
-- Rollback: v113-rollback-homeowner-next-steps-nudge-cron.sql
--   (cron.unschedule + delete the rate_limit_config row).
-- ============================================================================

-- 1. rate_limit_config entry.
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
  'send-homeowner-next-steps',
  4,
  48,
  1000,
  true,
  1.00,
  10.00,
  'gh-1580: every-30-min cron. Day-0 (+2h) / day-2 (+48h) nudge for is_test=false homeowners stalled at signup with no measurements/material/hover-order/activity.'
)
ON CONFLICT (function_name) DO NOTHING;

-- 2. pg_cron schedule — every 30 minutes, vault-backed service-role auth.
SELECT cron.schedule(
  'send-homeowner-next-steps',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/send-homeowner-next-steps',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);
