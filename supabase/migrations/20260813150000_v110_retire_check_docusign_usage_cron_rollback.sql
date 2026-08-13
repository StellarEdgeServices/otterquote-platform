-- Rollback for v110_retire_check_docusign_usage_cron.
--
-- Re-registers the check-docusign-usage pg_cron job with the exact
-- schedule and command captured live from project yeszghaspzwwstvsrioa on
-- 2026-08-13 (jobid was 9; cron.schedule assigns a new jobid on re-create,
-- which is fine — nothing else references the old jobid by number).
--
-- Only meaningful if supabase/functions/check-docusign-usage/ is also
-- restored (git revert of the function-deletion commit) — this rollback
-- does not resurrect the function code itself.

select cron.schedule(
  'check-docusign-usage',
  '0 12 * * *',
  $$
    SELECT net.http_post(
      url := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/check-docusign-usage'::text,
      headers := ('{"Content-Type": "application/json", "Authorization": "Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || '"}')::jsonb,
      body := '{}'
    ) AS request_id;
  $$
);
