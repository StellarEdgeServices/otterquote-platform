-- ============================================================================
-- v117 — pg_cron job 3 (process-bid-expirations) gets the service-role bearer
-- (gh-3104, caller gate on three cron Edge Functions)
-- ============================================================================
--
-- CONTEXT
--   process-bid-expirations was the one cron-invoked Edge Function whose job sent
--   NO Authorization header (v108 left it out for exactly that reason), so the
--   function accepted anyone. gh-3104 adds the same inbound gate the other cron
--   functions use (supabase/functions/process-bid-expirations/caller-gate.ts,
--   serviceGate). Once that function is deployed an unauthenticated tick is 401,
--   so the cron job MUST send the bearer first.
--
-- STATUS: PROPOSED — Tier 3 (changes cron.job.command). Not applied by the PR.
--
-- APPLY ORDER (this order matters)
--   1. Apply THIS file (job 3 starts sending `Bearer <vault cron_service_role_key>`;
--      the still-ungated deployed function ignores the header, so nothing breaks).
--   2. Confirm the next hourly cron.job_run_details row for jobid 3 is `succeeded`.
--   3. Deploy the process-bid-expirations Edge Function from this PR.
--   Deploying the function before this file makes every hourly sweep 401 until applied.
--
-- AUTH PATTERN: identical to the process-coi-reminders job (v108): Bearer from
--   vault.decrypted_secrets name = 'cron_service_role_key' (the key serviceGate accepts).
--
-- ROLLBACK: v117-rollback-process-bid-expirations-cron-bearer.sql
-- ============================================================================

DO $v117$
DECLARE
  updated INT := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') THEN
    RAISE EXCEPTION 'v117: vault secret cron_service_role_key missing — aborting before touching job 3';
  END IF;

  UPDATE cron.job SET command = $cmd$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-bid-expirations',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $cmd$ WHERE jobname = 'process-bid-expirations';
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated <> 1 THEN
    RAISE EXCEPTION 'v117 process-bid-expirations: expected 1 cron.job row updated, got %', updated;
  END IF;
END
$v117$;

-- Verify (read-only): the command now carries the vault bearer and no literal key.
-- SELECT jobid, (command ~ 'cron_service_role_key') AS vault_bearer, (command ~ '[A-Za-z0-9_-]{40,}') AS long_literal
--   FROM cron.job WHERE jobname = 'process-bid-expirations';
