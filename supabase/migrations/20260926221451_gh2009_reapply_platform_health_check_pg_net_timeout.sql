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
--     -> 0 rows   (183 rows recorded in production as of the PR #2227 review,
--                  2026-09-26T21:32Z; none match this fix)
--
--     SELECT jobid, jobname, command FROM cron.job WHERE jobid = 7;
--     -> command has no `timeout_milliseconds` argument, still the pg_net
--        5000ms implicit default, confirmed again at review time.
--
--   Effect (measured live, project yeszghaspzwwstvsrioa): platform-health-
--   check-cron (jobid 7, */15 * * * *) timed out on 17 of 24 quarter-hour
--   ticks (71%) in the retained pg_net window 15:30-21:15Z on 2026-09-26 --
--   either during DNS resolution or because the function's own multi-phase
--   runtime (measured p95 7.4s, max 10.0s over the trailing 24h; #780's
--   calculated pathological worst case ~33s) exceeds pg_net's 5s client-side
--   wait. pg_cron's `cron.job_run_details` reports every one of these ticks
--   as "succeeded" (net.http_post is fire-and-forget from cron's point of
--   view), so the health check has been silently failing to report for over
--   a month while looking healthy in cron's own bookkeeping. Full evidence
--   trail: issue #2009 (comments 2026-09-17 through 2026-09-26) and the PR
--   #2227 review (comment 5850073954).
--
-- WHY A NEW MIGRATION, NOT JUST RE-MERGING #780:
--   The original file is already on `main`, unmodified -- re-adding it
--   changes nothing. No workflow in .github/workflows/ runs `supabase db
--   push` or otherwise applies migrations (confirmed by grep across all
--   workflow files), so merging a file into supabase/migrations/ does NOT
--   by itself change production -- that is exactly how #780 went stale for
--   44 days. This migration reissues the identical, idempotent
--   `cron.alter_job` call under a new timestamp; per supabase/migrations/
--   README.md, a file in this directory represents SQL that has already
--   been applied, and its filename is renamed to the version production
--   records for it once that happens. The CTO session applies this exact
--   statement to production out-of-band (Supabase `apply_migration`) and
--   re-reads `cron.job` to confirm `timeout_milliseconds := 35000` before
--   this file is renamed and the PR is merged.
--
-- FIX: identical to 20260812200000_gh738_..., restated here --
--   platform-health-check-cron gets timeout_milliseconds := 35000 (comfortably
--   above the measured 24h max of 10.0s and #780's ~33s pathological worst
--   case, trivial next to the job's 15-minute cadence).
--   URL, headers and body are unchanged; no data is read, written or deleted.
--
-- Reversible via supabase/migrations_rollbacks/20260926221451_gh2009_reapply_
--   platform_health_check_pg_net_timeout_rollback.sql, which restores the
--   command text to its current (no-timeout) live form.
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
