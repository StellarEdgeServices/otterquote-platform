-- gh-3428: owner alert sweep. Schedule half: one pg_cron job that calls the Edge Function owner-alert-sweep every 30 seconds.
-- STATUS (gh-1438, as of 2026-11-05): NOT APPLIED
-- EVIDENCE: drafted on main 32193ce7. pg_cron 1.6.4 was recorded as installed on production on 2026-08-18 (supabase/migrations/20260101000001_v000b_pg_cron_extension.sql, #1022); the '30 seconds'
-- interval syntax needs pg_cron 1.5 or later. Not re-read by the author (no database connection): the applier re-reads cron.extversion first (pre-flight check 6). If it is older than 1.5, do NOT
-- apply this file as written: the closes-on says 60 seconds, a 1-minute cron plus run time can miss it, and that must be put on #3428 first.
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: Tier 3B path only. Apply AFTER gh3428_owner_alert_sweep.sql, AFTER owner-alert-sweep is deployed, AFTER the secrets OWNER_ALERT_PHONE, TWILIO_ACCOUNT_SID,
-- TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER exist (this file creates no secret). Until then a tick calls a function that is missing or refuses (harmless, no call).
-- Rollback: supabase/migrations_rollbacks/gh3428_owner_alert_sweep_rollback.sql (section 1)
-- Pre-flight: supabase/migrations_rollbacks/gh3428_owner_alert_sweep_pre-flight.md
--
-- Mechanism copies the repo's own pattern (20260914211825_gh1932_homeowner_signup_sweep_cron.sql): net.http_post with the service-role key read from Vault ('cron_service_role_key') at fire time.
-- net.http_post is asynchronous: the tick returns at once and a slow Edge Function never holds a cron worker. Name is unique, so re-running the file replaces the job rather than doubling it.

BEGIN;

SELECT cron.schedule(
  'gh3428-owner-alert-sweep',
  '30 seconds',
  $cron$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/owner-alert-sweep',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $cron$
);

COMMIT;
