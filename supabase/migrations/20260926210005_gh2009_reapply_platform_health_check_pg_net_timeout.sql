-- ============================================================================
-- gh-2009: re-apply the gh-738 pg_net timeout fix (PR #780), which was
-- merged to main on 2026-08-13 but never executed against production.
-- ============================================================================
--
-- WHAT HAPPENED:
--   supabase/migrations/20260812200000_gh738_platform_health_check_pg_net_timeout.sql
--   (added by PR #780, closing #738) sets an explicit timeout_milliseconds
--   on platform-health-check-cron's net.http_post() call. That file has been
--   on `main` since 2026-08-13, but it was never run against the production
--   database:
--
--     SELECT version, name FROM supabase_migrations.schema_migrations
--      WHERE name ILIKE '%738%' OR name ILIKE '%health_check%';
--     -> 0 rows   (159 other migrations recorded, including several from the
--                  same 2026-08-12 batch, e.g. v108_pg_cron_vault_secrets)
--
--     SELECT jobid, jobname, command FROM cron.job WHERE jobid = 7;
--     -> command has no `timeout_milliseconds` argument, still the pg_net
--        5000ms implicit default, as of 2026-09-26 21:00:05Z.
--
--   Effect (measured live, project yeszghaspzwwstvsrioa, response id 31501
--   among many others): platform-health-check-cron (jobid 7, */15 * * * *)
--   times out on ~75-85% of its ticks at the 5000ms pg_net default -- either
--   during DNS resolution or because the function's own multi-phase runtime
--   (calculated worst case ~33s: 6 parallel EF pings + 2 sequential public-
--   path probes with retry + a DB staleness check) exceeds 5s. pg_cron's
--   `cron.job_run_details` reports every one of these ticks as "succeeded"
--   (pg_net's http_post is fire-and-forget from cron's point of view), so
--   the health check -- the job whose entire purpose is to tell us the rest
--   of the platform is alive -- has been silently failing to report for
--   over a month while looking healthy in cron's own bookkeeping. Full
--   evidence trail: issue #2009 (comments 2026-09-17 through 2026-09-26).
--
-- WHY A NEW MIGRATION, NOT JUST RE-MERGING #780:
--   The original file is already on `main`, unmodified -- re-adding it
--   changes nothing. Whatever caused a merged migration to not be run
--   against prod (open question, flagged separately on #2009 for the
--   deploy-pipeline owner) will do the same to a re-push of the same file.
--   This migration reissues the identical, idempotent `cron.alter_job` call
--   under a new timestamp so it is picked up as a normal pending migration
--   on the next migration run, regardless of why the first one was missed.
--
-- FIX: identical to 20260812200000_gh738_..., restated here --
--   platform-health-check-cron gets timeout_milliseconds := 35000 (comfortably
--   above the ~33s worst case, trivial next to the job's 15-minute cadence).
--   URL, headers and body are unchanged; no data is read, written or deleted.
--
-- Reversible: re-run cron.alter_job for the same jobid with a command that
--   omits timeout_milliseconds, restoring the implicit 5000ms default.
-- ============================================================================

SELECT cron.alter_job(
  job_id  := (SELECT jobid FROM cron.job WHERE jobname = 'platform-health-check-cron'),
  command := $cmd$
  SELECT net.http_post(
    url := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/platform-health-check',
    headers := ('{"Content-Type": "application/json", "Authorization": "Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || '"}')::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 35000
  ) AS request_id;
  $cmd$
);
