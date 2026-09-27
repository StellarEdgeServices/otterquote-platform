-- D-339 (otterquote-ref-legal.md): lead-row retention purge job. ROUND 2.
-- Rule: `leads` rows are retained 4 years from `created_at`, then deleted,
-- UNLESS the lead is exempt. Distinct from D-334 (`lead_consents` evidence
-- retention -- kept, never purged by this job).
--
-- *** DRAFT ONLY (Tier 3B, destructive). NOT APPLIED. Requires the
-- standard 24-hour R-097 notice window before this migration is applied
-- or the cron job is enabled. ***
--
-- ROUND 2 changes, per REVIEW: FAIL 5858446793 (refuter) and Ben's ruling
-- 5858465140 on it -- both on PR #2269:
--
-- B1 (blocking, fixed): Supabase's default privileges grant EXECUTE on
-- every new `public` function to `anon` and `authenticated` in addition
-- to the owner, even after `REVOKE ALL ... FROM PUBLIC` (proven live by
-- the reviewer: `anon_exec=true auth_exec=true` inside this migration's
-- own aborted transaction). Fixed: explicit `REVOKE ... FROM PUBLIC, anon,
-- authenticated`, plus an in-migration assertion (`has_function_privilege`)
-- that aborts the whole migration if either role can still execute it.
--
-- B2 (blocking, fixed): `converted_user_id` alone under-covers "converted
-- to an account". It is written only by `set_lead_converted()`, which
-- only fires for React `get-started`/`auth-callback` signups within 24h
-- of lead creation with a matching JWT email -- the reviewer's live
-- SELECT found 0/105 leads with it set, while 58/105 null-converted leads
-- have an email that matches a real `auth.users` account (34 of those 58
-- also have a claim). Ben's ruling (ties to D-339's own wording, "deleted
-- unless the lead has converted to an account", and narrows the delete
-- set rather than widening it): a lead is EXEMPT from the purge if ANY of
-- the following holds --
--   (a) converted_user_id IS NOT NULL
--   (b) lower(trim(email)) matches lower(trim(email)) of any auth.users row
--   (c) it has a lead_consents row (D-334 evidence)
-- Synthetic leads (`is_synthetic`) get no special case under this rule,
-- per Ben's ruling -- they are purged or exempted on the same three tests
-- as every other row.
--
-- Non-blocking fixes folded in (N1, N2, N3 from the same review):
--  - N1: the function now RAISE LOG's both the candidate and deleted
--    counts on every call (dry-run and real), since `cron.job_run_details`
--    does not record them and nothing else would.
--  - N2: `search_path` now includes `pg_temp` (repo precedent:
--    `set_lead_converted`), not just `public`.
--  - N3: the paired rollback file's `cron.unschedule` call is now
--    idempotent -- guarded so a second run, or a rollback of a migration
--    that was never applied, does not raise "could not find valid entry
--    for job".
--
-- N4 (report-only, not this file): the CEO-73 D-339 report's claim that
-- `leads.created_at` is "indexed" was false (the reviewer checked
-- `pg_indexes`: only pkey, email, the reminder uidx and `meta_lead_id`
-- exist) and has been corrected in the report, not in this migration --
-- this migration never claimed an index.
--
-- Rollback: supabase/migrations_rollbacks/20260927175249_gh_d339_leads_retention_purge_rollback.sql

BEGIN;

CREATE OR REPLACE FUNCTION public.purge_expired_leads(p_dry_run boolean DEFAULT true)
RETURNS TABLE(candidate_count bigint, deleted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_candidates bigint;
  v_deleted bigint := 0;
BEGIN
  -- Candidates: created_at older than 4 years AND none of the three
  -- exemptions holds. See header for why each exemption exists.
  SELECT count(*) INTO v_candidates
  FROM public.leads l
  WHERE l.created_at < now() - interval '4 years'
    AND l.converted_user_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM auth.users u
      WHERE lower(trim(u.email)) = lower(trim(l.email))
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.lead_consents lc WHERE lc.lead_id = l.id
    );

  IF p_dry_run THEN
    RAISE LOG 'purge_expired_leads dry-run: % candidate row(s), 0 deleted', v_candidates;
    RETURN QUERY SELECT v_candidates, 0::bigint;
    RETURN;
  END IF;

  WITH doomed AS (
    SELECT l.id
    FROM public.leads l
    WHERE l.created_at < now() - interval '4 years'
      AND l.converted_user_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM auth.users u
        WHERE lower(trim(u.email)) = lower(trim(l.email))
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.lead_consents lc WHERE lc.lead_id = l.id
      )
  )
  DELETE FROM public.leads l
  USING doomed d
  WHERE l.id = d.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RAISE LOG 'purge_expired_leads: % candidate row(s), % deleted', v_candidates, v_deleted;

  RETURN QUERY SELECT v_candidates, v_deleted;
END;
$fn$;

-- B1 fix: explicit revoke from PUBLIC and from the two roles Supabase's
-- default privileges grant EXECUTE to automatically on every new function.
REVOKE ALL ON FUNCTION public.purge_expired_leads(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_leads(boolean) TO service_role;

-- B1 fix: assert the revoke actually took. If Supabase's default
-- privileges (or anything else) re-grant EXECUTE to anon/authenticated,
-- this aborts the whole migration rather than silently shipping the same
-- hole the reviewer found.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.purge_expired_leads(boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B1 regression: anon can still execute purge_expired_leads';
  END IF;
  IF has_function_privilege('authenticated', 'public.purge_expired_leads(boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B1 regression: authenticated can still execute purge_expired_leads';
  END IF;
END;
$$;

-- Scheduled DAILY at 03:17 UTC (off-peak), dry_run := false. To rehearse
-- with no writes before/after go-live: SELECT public.purge_expired_leads(true);
SELECT cron.schedule(
  'd339-leads-retention-purge',
  '17 3 * * *',
  $cron$ SELECT public.purge_expired_leads(false); $cron$
);

COMMIT;
