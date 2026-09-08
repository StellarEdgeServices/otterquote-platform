-- Migration: v108c_fix_warranty_manifest_unbalanced_paren
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-12T12:57:39Z, recorded in
-- supabase_migrations.schema_migrations as version 20260812125739, name
-- "v108c_fix_warranty_manifest_unbalanced_paren". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v108c — v108b's generic paren-insertion hotfix assumed the JSON body ends
-- immediately after the Bearer value (true for platform-health-check-cron
-- and check-docusign-usage). warranty-manifest-refresh has "Content-Type"
-- AFTER "Authorization" in its JSON, so the hotfix's paren-insertion applied
-- without a matching close, leaving unbalanced parens. Fixing directly with
-- an explicit, pre-validated command (validated headers expression by
-- standalone SELECT before this apply — see report).
DO $fix$
DECLARE
  target_jobid INT;
  new_cmd TEXT := $cmd$SELECT net.http_post(
    url := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/refresh-warranty-manifest',
    headers := ('{"Authorization": "Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || '", "Content-Type": "application/json"}')::jsonb,
    body := '{}'::jsonb
  ) AS request_id$cmd$;
BEGIN
  SELECT jobid INTO target_jobid FROM cron.job WHERE jobname = 'warranty-manifest-refresh';
  IF target_jobid IS NULL THEN
    RAISE EXCEPTION 'warranty-manifest-refresh job not found — aborting';
  END IF;
  PERFORM cron.alter_job(target_jobid, command := new_cmd);
END
$fix$;
