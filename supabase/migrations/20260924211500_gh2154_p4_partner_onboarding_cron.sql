-- gh-2154 P-4: register the partner onboarding sweep on pg_cron.
--
-- Same pg_cron -> net.http_post -> vault secret pattern as this repo's other
-- scheduled EFs (send-homeowner-next-steps, gh1932-homeowner-signup-sweep),
-- using vault secret cron_service_role_key (confirmed present live, same
-- secret 10+ live cron jobs and every notify_admin_new_* trigger already
-- uses).
--
-- Schedule: every 15 minutes, matching gh1932-homeowner-signup-sweep's own
-- cadence (20260914211825_gh1932_homeowner_signup_sweep_cron.sql) rather
-- than send-homeowner-next-steps' 30-minute tick -- this sequence's coarsest
-- boundary is a full day (day1/day3/day7), so a 15-minute tick costs nothing
-- in extra load while keeping day0 (age >= 0) responsive to a same-day
-- signup.
--
-- DEPLOY ORDER (binding, same rule P-3's migration states for its own Edge
-- Function dependency): this migration is applied ONLY after
-- send-partner-onboarding is deployed and byte-verified -- nothing reaches
-- prod that calls a function not yet live. The kill switch
-- (platform_settings.partner_onboarding_enabled) stays OFF (absent, which
-- already means OFF -- see ./send-partner-onboarding/kill-switch.ts) through
-- this migration landing; flipping it ON is a separate, later, Dustin-only
-- step, gated on Sloane's real copy replacing every `[[...]]` placeholder in
-- send-partner-onboarding/copy.ts. Registering the cron job before the
-- switch is ON is intentional and safe: every invocation returns 200
-- {skipped:'disabled'} and touches neither referral_agents nor the ledger.
--
-- Rollback: see
-- supabase/migrations_rollbacks/20260924211500_gh2154_p4_partner_onboarding_cron_rollback.sql
-- -- select cron.unschedule('gh2154-p4-partner-onboarding-sweep').

BEGIN;

SELECT cron.schedule(
  'gh2154-p4-partner-onboarding-sweep',
  '*/15 * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/send-partner-onboarding',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $cron$
);

COMMIT;
