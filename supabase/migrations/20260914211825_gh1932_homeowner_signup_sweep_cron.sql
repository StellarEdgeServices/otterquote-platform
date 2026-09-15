-- gh-1932 rework 2 (CEO ruling, issue #1932 comment 5670873022): deferred
-- signup sweep. Every 15 minutes, invoke notify-admin-new-homeowner in
-- signup_sweep mode. Same pg_cron -> net.http_post -> vault secret pattern
-- as the repo's other scheduled EFs (e.g. send-homeowner-next-steps,
-- process-coi-reminders), using vault secret cron_service_role_key.
--
-- Applied live as schema_migrations version 20260914211825 (matches this filename).
--
-- Rollback:
--   select cron.unschedule('gh1932-homeowner-signup-sweep');
--   delete from public.notifications where notification_type in
--     ('admin_new_homeowner','admin_homeowner_signup_digest');
BEGIN;

SELECT cron.schedule(
  'gh1932-homeowner-signup-sweep',
  '*/15 * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-admin-new-homeowner',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
    ),
    body    := '{"event_type":"signup_sweep"}'::jsonb
  ) AS request_id;
  $cron$
);

COMMIT;
