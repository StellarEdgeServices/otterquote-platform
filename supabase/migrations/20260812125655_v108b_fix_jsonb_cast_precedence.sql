-- Migration: v108b_fix_jsonb_cast_precedence
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-12T12:56:55Z, recorded in
-- supabase_migrations.schema_migrations as version 20260812125655, name
-- "v108b_fix_jsonb_cast_precedence". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- ============================================================================
-- v108b — HOTFIX: v108's headers expression for the 3 "raw JSON-text cast"
-- jobs (platform-health-check-cron, check-docusign-usage,
-- warranty-manifest-refresh) is broken. `::jsonb` binds tighter than `||`,
-- so `'...' || (subquery) || '"}'::jsonb` only casts the trailing literal
-- '"}' to jsonb — which is not valid JSON on its own — instead of casting
-- the full concatenated string. Caught by a manual smoke test before any
-- scheduled cron run hit it (jobid 7's next fire was ~13:00 UTC; this
-- landed at 12:56 UTC). Fix: wrap the full concatenation in parentheses
-- before the cast.
-- ============================================================================

DO $hotfix$
DECLARE
  r RECORD;
  new_cmd TEXT;
  target_jobs CONSTANT TEXT[] := ARRAY['platform-health-check-cron','check-docusign-usage','warranty-manifest-refresh'];
  fixed_count INT := 0;
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname = ANY(target_jobs)) <> 3 THEN
    RAISE EXCEPTION 'Expected exactly 3 target jobs, found % — aborting', (SELECT count(*) FROM cron.job WHERE jobname = ANY(target_jobs));
  END IF;

  FOR r IN SELECT jobid, jobname, command FROM cron.job WHERE jobname = ANY(target_jobs) LOOP
    IF r.command NOT LIKE '%''::jsonb%' OR r.command NOT LIKE '%vault.decrypted_secrets%' THEN
      RAISE EXCEPTION 'Job % (id %) does not match the expected v108 broken shape — aborting', r.jobname, r.jobid;
    END IF;

    -- Wrap the concatenation in parens before the cast:
    --   '{"..."}' || (SELECT ...) || '"}'::jsonb
    --   -> ('{"..."}' || (SELECT ...) || '"}')::jsonb
    new_cmd := replace(
      r.command,
      $$ || '"}'::jsonb$$,
      $$ || '"}')::jsonb$$
    );
    new_cmd := replace(
      new_cmd,
      case r.jobname
        when 'platform-health-check-cron' then $$headers := '{"Content-Type"$$
        when 'check-docusign-usage'       then $$headers:='{"Content-Type"$$
        when 'warranty-manifest-refresh'  then $$headers := '{"Authorization"$$
      end,
      case r.jobname
        when 'platform-health-check-cron' then $$headers := ('{"Content-Type"$$
        when 'check-docusign-usage'       then $$headers:=('{"Content-Type"$$
        when 'warranty-manifest-refresh'  then $$headers := ('{"Authorization"$$
      end
    );

    IF new_cmd = r.command THEN
      RAISE EXCEPTION 'Hotfix replacement produced no change for job % (id %) — aborting', r.jobname, r.jobid;
    END IF;

    PERFORM cron.alter_job(r.jobid, command := new_cmd);
    fixed_count := fixed_count + 1;
  END LOOP;

  IF fixed_count <> 3 THEN
    RAISE EXCEPTION 'Expected to fix exactly 3 jobs, fixed % — aborting', fixed_count;
  END IF;
END
$hotfix$;
