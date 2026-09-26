-- gh-2154 P-5 go-live (Ben, bus 2026-09-25T22:17:42Z item 2): register the
-- Meta-lead invite 48h reminder sweep on pg_cron. Same pg_cron ->
-- net.http_post -> vault secret cron_service_role_key pattern as P-4's own
-- 20260924211500_gh2154_p4_partner_onboarding_cron.sql (which this stacks
-- on -- see that migration's own note for the vault secret's provenance).
--
-- Schedule: every 15 minutes, same cadence as P-4's own sweep -- the
-- coarsest boundary here (48h) tolerates a 15-minute tick trivially, and
-- reusing the identical cadence keeps operational load predictable.
--
-- DEPLOY ORDER (binding, same rule every scheduled-EF migration in this
-- repo states): applied ONLY after send-partner-invite-reminder is
-- deployed and byte-verified. The function itself is gated OFF by default
-- (PARTNER_INVITE_EMAIL_ENABLED, same switch the initial invite email
-- uses -- this task's own brief: "put it behind the same invite switch"),
-- so registering this cron job before the switch is ON is intentional and
-- safe: every invocation returns 200 with nothing sent and touches neither
-- referral_agents nor the ledger.
--
-- Rollback: see
-- supabase/migrations_rollbacks/20260925223000_gh2154_p5_invite_reminder_cron_rollback.sql
-- -- select cron.unschedule('gh2154-p5-invite-reminder-sweep').

BEGIN;

SELECT cron.schedule(
  'gh2154-p5-invite-reminder-sweep',
  '*/15 * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/send-partner-invite-reminder',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $cron$
);

COMMIT;
