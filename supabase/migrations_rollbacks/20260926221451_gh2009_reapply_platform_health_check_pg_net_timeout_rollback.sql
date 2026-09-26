-- ============================================================================
-- gh-2009 ROLLBACK: restore platform-health-check-cron to the pg_net 5000ms
-- implicit default (undo timeout_milliseconds := 35000).
-- ============================================================================
--
-- Command text below is byte-identical to the live cron.job command for
-- jobid 7 as read on 2026-09-26 (per PR #2227 review, comment 5850073954,
-- evidence item 1) -- same URL, same vault-secret header construction, same
-- body, no timeout_milliseconds argument.
-- ============================================================================

BEGIN;

SELECT cron.alter_job(
  job_id  := (SELECT jobid FROM cron.job WHERE jobname = 'platform-health-check-cron'),
  command := $cmd$
  SELECT net.http_post(
    url := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/platform-health-check',
    headers := ('{"Content-Type": "application/json", "Authorization": "Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || '"}')::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $cmd$
);

COMMIT;
