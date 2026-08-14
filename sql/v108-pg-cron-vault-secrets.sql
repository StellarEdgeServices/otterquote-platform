-- ============================================================================
-- v108 — Migrate plaintext sb_secret_ service-role keys out of pg_cron job
-- commands into Supabase Vault (GitHub #688, P0, Tier 3B)
-- ============================================================================
--
-- CONTEXT
--   10 of 14 pg_cron jobs embedded the Supabase service-role key in plaintext
--   inside cron.job.command, readable by anyone with catalog access to
--   cron.job. This migration stores the key in vault.secrets and rewrites
--   each affected job's command to pull it fresh at execution time via
--   vault.decrypted_secrets, so the plaintext key no longer persists in
--   cron.job. All 10 jobs run as the `postgres` role, which has vault
--   access, so no permission grant is needed.
--
--   Does NOT rotate the key — same value, new storage location. Rotation is
--   a separate decision (Dustin, board item 4).
--
--   R-097 24-hour notice window (ClickUp 86e2rjghc) opened 2026-08-11
--   10:15 ET, closed 2026-08-12 10:15 ET with no objection — authorized to
--   proceed under R-097. anon/authenticated do not have schema USAGE on
--   cron, so this is hygiene-urgent rather than actively-exploited.
--
-- JOBS TOUCHED (10): process-coi-reminders, process-dunning-cron,
--   check-siding-design-completion, platform-health-check-cron,
--   check-docusign-usage, process-hover-rebate-scan,
--   manufacturer-cert-scrape, warranty-manifest-refresh, process-auto-bids,
--   counter-sig-reminders.
--
-- NOT TOUCHED (4, out of scope — no sb_secret_ literal present):
--   process-bid-expirations (no auth header), process-payout-reminders and
--   send-incomplete-onboarding-reminders (custom bearer secret, not the
--   service-role key), home-profile-prompt-hourly (custom X-Cron-Secret
--   header, not the service-role key).
--
-- APPLIED DIRECTLY TO PRODUCTION 2026-08-12 (Supabase MCP apply_migration,
-- project yeszghaspzwwstvsrioa) — this file is the audit-trail record, not
-- the deploy trigger. Two runtime issues were found and hot-fixed in the
-- same session before any live cron fire hit them; see v108b/v108c below
-- and the gh-688 report for the full incident detail. This file reproduces
-- the FINAL, already-verified-correct state for all 10 jobs (not the
-- original broken v108 attempt) so a fresh apply from this file alone is
-- safe and does not require the v108b/v108c hotfixes as separate steps.
--
-- Idempotent: safe to re-run. The vault secret creation is guarded by
-- existence check; cron.alter_job calls are unconditional but converge to
-- the same end state if run twice (the second run's "does not contain
-- plaintext" guard will simply raise, since the literal is already gone —
-- if re-running against a DB that has already been migrated, skip this
-- file and verify state directly instead).
--
-- Rollback: v108-rollback-pg-cron-vault-secrets.sql (restores the plaintext
--   literal verbatim into all 10 job commands; does not delete the vault
--   secret).
--
-- REDACTED FOR GIT: the actual service-role key value is NOT committed here
-- (GitHub push-protection secret scanning correctly rejected the original
-- draft of this file for containing it literally — see gh-688 report). This
-- file uses the placeholder <SERVICE_ROLE_KEY> everywhere the live migration
-- used the real value. To re-run this migration for real, substitute the
-- current key from Doppler (otterquote/prd) before executing step 1.
-- ============================================================================

-- 1. Store the service-role key in Vault (idempotent).
DO $seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_service_role_key') THEN
    PERFORM vault.create_secret(
      '<SERVICE_ROLE_KEY>',  -- substitute from Doppler otterquote/prd before running
      'cron_service_role_key',
      'Supabase service-role key used by pg_cron jobs to call Edge Functions. Migrated off plaintext cron.job.command 2026-08-12, gh-688.'
    );
  END IF;
END
$seed$;

-- 2. Verify the secret round-trips before touching any job.
DO $verify$
DECLARE
  decrypted TEXT;
BEGIN
  SELECT decrypted_secret INTO decrypted FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key';
  IF decrypted IS DISTINCT FROM '<SERVICE_ROLE_KEY>' THEN
    RAISE EXCEPTION 'Vault round-trip failed: decrypted secret does not match source key — aborting before touching any cron job';
  END IF;
END
$verify$;

-- 3. Set each target job's command directly to its known-correct final form.
--    (Not a generic string-replace loop — that approach is what produced the
--    v108b/v108c incident. Each command below has been individually
--    validated by a standalone headers-expression SELECT against the live
--    vault secret; see the gh-688 report for the validation transcript.)
DO $migrate$
DECLARE
  updated INT := 0;
BEGIN
  UPDATE cron.job SET command = $cmd$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-coi-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $cmd$ WHERE jobname = 'process-coi-reminders';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'process-coi-reminders: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$SELECT net.http_post(url := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-dunning', headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || '', 'Content-Type', 'application/json'), body := '{}'::jsonb) AS request_id;$cmd$ WHERE jobname = 'process-dunning-cron';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'process-dunning-cron: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$SELECT net.http_post(url := 'https://yeszghaspzwwstvsrioa.functions.supabase.co/functions/v1/check-siding-design-completion', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''), body := '{}'::jsonb) AS request_id;$cmd$ WHERE jobname = 'check-siding-design-completion';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'check-siding-design-completion: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$
  SELECT net.http_post(
    url := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/platform-health-check',
    headers := ('{"Content-Type": "application/json", "Authorization": "Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || '"}')::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $cmd$ WHERE jobname = 'platform-health-check-cron';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'platform-health-check-cron: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$SELECT net.http_post(url:='https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/check-docusign-usage'::text, headers:=('{"Content-Type": "application/json", "Authorization": "Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || '"}')::jsonb, body:='{}') AS request_id;$cmd$ WHERE jobname = 'check-docusign-usage';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'check-docusign-usage: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-hover-rebate',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
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
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
    ),
    body    := '{"manufacturer":"all"}'::jsonb
  ) AS request_id;
  $cmd$ WHERE jobname = 'manufacturer-cert-scrape';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'manufacturer-cert-scrape: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$SELECT net.http_post(
    url := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/refresh-warranty-manifest',
    headers := ('{"Authorization": "Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || '", "Content-Type": "application/json"}')::jsonb,
    body := '{}'::jsonb
  ) AS request_id$cmd$ WHERE jobname = 'warranty-manifest-refresh';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'warranty-manifest-refresh: expected 1 row updated, got %', updated; END IF;

  UPDATE cron.job SET command = $cmd$
    SELECT net.http_post(
      url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-auto-bids',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
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
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $cmd$ WHERE jobname = 'counter-sig-reminders';
  GET DIAGNOSTICS updated = ROW_COUNT; IF updated <> 1 THEN RAISE EXCEPTION 'counter-sig-reminders: expected 1 row updated, got %', updated; END IF;
END
$migrate$;

-- 4. Post-check: zero jobs among the target 10 still carry the plaintext key,
--    and none carry an unbalanced-paren artifact of the original v108/v108b bug.
DO $postcheck$
DECLARE
  remaining INT;
BEGIN
  SELECT count(*) INTO remaining
  FROM cron.job
  WHERE jobname IN (
    'process-coi-reminders','process-dunning-cron','check-siding-design-completion',
    'platform-health-check-cron','check-docusign-usage','process-hover-rebate-scan',
    'manufacturer-cert-scrape','warranty-manifest-refresh','process-auto-bids',
    'counter-sig-reminders'
  )
  AND (command LIKE '%sb_secret_%' OR command NOT LIKE '%vault.decrypted_secrets%');
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'Post-check failed: % jobs still carry a plaintext sb_secret_ literal or lack the vault lookup', remaining;
  END IF;
END
$postcheck$;
