-- D-339 (otterquote-ref-legal.md): lead-row retention purge job.
-- Rule: `leads` rows are retained 4 years from `created_at`, then deleted,
-- UNLESS the lead converted to an account. Distinct from D-334
-- (`lead_consents` evidence retention -- kept, never purged by this job).
--
-- "Converted to an account" signal used: leads.converted_user_id (uuid,
-- FK -> auth.users(id) ON DELETE SET NULL). This column is written by
-- set_lead_converted(p_lead_id) as of gh-2121 (LRS HO-1 S16, revised
-- 2026-09-24) -- confirmed via Supabase MCP list_tables (verbose) against
-- project yeszghaspzwwstvsrioa, read-only, 2026-09-27. A NULL value means
-- the lead never converted and is purge-eligible once past the retention
-- window; a non-NULL value means it has an account and is exempt.
--
-- D-334 safety: lead_consents.lead_id -> leads.id is ON DELETE RESTRICT
-- (confirmed via `select confdeltype from pg_constraint where conname =
-- 'lead_consents_lead_id_fkey'` -> 'r', read-only, 2026-09-27). A hard
-- DELETE that hit a leads row with a lead_consents row would raise a FK
-- violation and abort the whole statement. This job therefore explicitly
-- excludes any leads row that has a lead_consents row (NOT EXISTS below),
-- so it can never touch or be blocked by consent-evidence rows.
--
-- Same pg_cron scheduling pattern as this repo's existing jobs (e.g.
-- 20260914211825_gh1932_homeowner_signup_sweep_cron.sql), but this job
-- calls a SECURITY DEFINER SQL function directly rather than an Edge
-- Function over net.http_post -- no external call is needed for a
-- same-database DELETE, and this keeps the destructive SQL in one
-- reviewable place. Dry-run mode is the function's default and lets an
-- operator get a candidate count with no writes before ever passing false.
--
-- *** DRAFT ONLY (Tier 3B, destructive). NOT APPLIED. Requires the
-- standard 24-hour R-097 notice window before this migration is applied
-- or the cron job is enabled. ***
--
-- Rollback: supabase/migrations_rollbacks/20260927175249_gh_d339_leads_retention_purge_rollback.sql

BEGIN;

CREATE OR REPLACE FUNCTION public.purge_expired_leads(p_dry_run boolean DEFAULT true)
RETURNS TABLE(candidate_count bigint, deleted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_candidates bigint;
  v_deleted bigint := 0;
BEGIN
  -- Candidates: created_at older than 4 years, never converted to an
  -- account (converted_user_id IS NULL), and carrying no lead_consents
  -- evidence row (D-334 -- never purge alongside or in place of consent
  -- evidence; a row WITH consent evidence is left in place indefinitely
  -- by this job, same as D-334 already requires).
  SELECT count(*) INTO v_candidates
  FROM public.leads l
  WHERE l.created_at < now() - interval '4 years'
    AND l.converted_user_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.lead_consents lc WHERE lc.lead_id = l.id
    );

  IF p_dry_run THEN
    RETURN QUERY SELECT v_candidates, 0::bigint;
    RETURN;
  END IF;

  WITH doomed AS (
    SELECT l.id
    FROM public.leads l
    WHERE l.created_at < now() - interval '4 years'
      AND l.converted_user_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.lead_consents lc WHERE lc.lead_id = l.id
      )
  )
  DELETE FROM public.leads l
  USING doomed d
  WHERE l.id = d.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN QUERY SELECT v_candidates, v_deleted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.purge_expired_leads(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_expired_leads(boolean) TO service_role;

-- Scheduled DAILY at 03:17 UTC (off-peak), dry_run := false. To rehearse
-- with no writes before/after go-live: SELECT public.purge_expired_leads(true);
SELECT cron.schedule(
  'd339-leads-retention-purge',
  '17 3 * * *',
  $cron$ SELECT public.purge_expired_leads(false); $cron$
);

COMMIT;
