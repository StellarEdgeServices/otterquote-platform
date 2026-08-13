-- ============================================================================
-- gh-738: set explicit pg_net timeout for platform-health-check-cron
-- ============================================================================
--
-- ROOT CAUSE (already diagnosed on the issue, not re-derived here):
--   No cron.job command in this database passes `timeout_milliseconds` to its
--   net.http_post() call, so every one of the 14 pg_cron jobs that call out
--   via pg_net runs on pg_net's implicit 5000ms default.
--
--   Evidence: at the :15/:45 marks, where only process-auto-bids (control,
--   cheap/fast function, 0 errors across 48 fires) and platform-health-check-cron
--   fire together, 7 of 12 responses time out (58%) -- all seven are the
--   health-check call specifically. platform-health-check fans out to more
--   work than the other jobs studied:
--     Phase 1 -- pings 6 Edge Functions in parallel, each capped at 5000ms
--               (PING_TIMEOUT_MS) -- worst case ~5s
--     Phase 3 -- probes 2 public paths in parallel, each with a 10000ms
--               fetch timeout (PUBLIC_PATH_TIMEOUT_MS) AND an in-run retry
--               after a 5000ms delay (PUBLIC_PATH_RETRY_DELAY_MS) before
--               recording a failure -- worst case per path ~25s
--               (10s + 5s + 10s), run sequentially after Phase 1
--     Phase 2 -- cron staleness check, DB-only reads/writes -- low, ~1-3s
--   Phases run sequentially inside the function (1 -> 3 -> 2), so the
--   function's own worst-case runtime is roughly 5s + 25s + ~3s = ~33s
--   under pathological conditions (a public path probe failing twice).
--   Typical/healthy runtime is well under 5s. 5000ms is therefore adequate
--   for the fast control job (process-auto-bids) but structurally too low
--   for platform-health-check, independent of any contention.
--
-- FIX: give platform-health-check-cron (jobid 7 as of 2026-08-12) an explicit
--   timeout_milliseconds := 35000 on its net.http_post() call -- comfortably
--   above the ~33s calculated worst case, with margin, while remaining
--   trivial relative to the job's 15-minute cadence.
--
-- SCOPE: this migration touches ONLY platform-health-check-cron.
--   The other 13 pg_net-calling cron jobs were evaluated and deliberately
--   left on the 5000ms default -- see the PR description for the per-job
--   rationale (control job, low-frequency/low-contention jobs, and jobs in
--   the separately-diagnosed :00/:30 thundering-herd DNS window that this
--   change must not be used to band-aid).
--
-- Before / after:
--   jobname                      | before (pg_net default) | after
--   ------------------------------+--------------------------+----------
--   platform-health-check-cron   | 5000ms (implicit)        | 35000ms (explicit)
--
-- Reversible: re-run cron.alter_job for jobid 7 with the original command
--   (net.http_post call without a timeout_milliseconds argument) to restore
--   the implicit 5000ms default.
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
