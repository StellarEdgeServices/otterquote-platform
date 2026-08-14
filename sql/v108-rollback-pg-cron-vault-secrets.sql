-- ============================================================================
-- v108 ROLLBACK — restore plaintext sb_secret_ service-role key into the 10
-- pg_cron job commands migrated to Vault by v108-pg-cron-vault-secrets.sql
-- (GitHub #688)
-- ============================================================================
--
-- Restores each of the 10 target jobs to its exact pre-migration command
-- (verbatim, captured before v108 ran). Does NOT delete the
-- 'cron_service_role_key' vault secret — leaving it in place is harmless and
-- avoids a second migration needing to recreate it if v108 is reapplied.
--
-- REDACTED FOR GIT: this file's entire purpose is putting the plaintext key
-- back into cron.job.command, so it necessarily contains the literal
-- everywhere below. GitHub push-protection secret scanning correctly
-- rejects that. Every occurrence is replaced with the placeholder
-- <SERVICE_ROLE_KEY> — substitute the current key from Doppler
-- (otterquote/prd) via search-and-replace before actually running this
-- rollback. Running this file as committed (with the literal placeholder
-- text) is a harmless no-op that will not authenticate.
-- ============================================================================

DO $rollback$
DECLARE
  updated INT := 0;
BEGIN
  UPDATE cron.job SET command = $cmd$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-coi-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $cmd$ WHERE jobname = 'process-coi-reminders';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'process-coi-reminders: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$SELECT net.http_post(url := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-dunning', headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>', 'Content-Type', 'application/json'), body := '{}'::jsonb) AS request_id;$cmd$ WHERE jobname = 'process-dunning-cron';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'process-dunning-cron: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$SELECT net.http_post(url := 'https://yeszghaspzwwstvsrioa.functions.supabase.co/functions/v1/check-siding-design-completion', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer <SERVICE_ROLE_KEY>'), body := '{}'::jsonb) AS request_id;$cmd$ WHERE jobname = 'check-siding-design-completion';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'check-siding-design-completion: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$
  SELECT net.http_post(
    url := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/platform-health-check',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer <SERVICE_ROLE_KEY>"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $cmd$ WHERE jobname = 'platform-health-check-cron';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'platform-health-check-cron: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$SELECT net.http_post(url:='https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/check-docusign-usage'::text, headers:='{"Content-Type": "application/json", "Authorization": "Bearer <SERVICE_ROLE_KEY>"}'::jsonb, body:='{}') AS request_id;$cmd$ WHERE jobname = 'check-docusign-usage';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'check-docusign-usage: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-hover-rebate',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body    := '{"scan": true}'::jsonb
  ) AS request_id;
  $cmd$ WHERE jobname = 'process-hover-rebate-scan';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'process-hover-rebate-scan: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/scrape-manufacturer-certs',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body    := '{"manufacturer":"all"}'::jsonb
  ) AS request_id;
  $cmd$ WHERE jobname = 'manufacturer-cert-scrape';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'manufacturer-cert-scrape: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$SELECT net.http_post(
    url := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/refresh-warranty-manifest',
    headers := '{"Authorization": "Bearer <SERVICE_ROLE_KEY>", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id$cmd$ WHERE jobname = 'warranty-manifest-refresh';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'warranty-manifest-refresh: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$
    SELECT net.http_post(
      url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-auto-bids',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
      ),
      body    := '{}'::jsonb
    ) AS request_id;
  $cmd$ WHERE jobname = 'process-auto-bids';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'process-auto-bids: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/counter-sig-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $cmd$ WHERE jobname = 'counter-sig-reminders';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'counter-sig-reminders: expected 1 row updated, got %', updated; END IF;
END
$rollback$;
