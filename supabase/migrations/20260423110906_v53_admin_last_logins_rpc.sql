-- Migration: v53_admin_last_logins_rpc
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-04-23T11:09:06Z, recorded in
-- supabase_migrations.schema_migrations as version 20260423110906, name
-- "v53_admin_last_logins_rpc". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- Closes ClickUp 86e11fa1g — replace the revoked admin_contractor_last_logins view
-- with a SECURITY DEFINER RPC that doesn't expose auth.users via PostgREST.
-- Applied via Management API (no commit required). Session 355, April 23, 2026.

CREATE OR REPLACE FUNCTION public.get_contractor_last_logins()
RETURNS TABLE (contractor_id uuid, last_sign_in_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.email() IS DISTINCT FROM 'dustinstohler1@gmail.com' THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  RETURN QUERY
  SELECT c.id AS contractor_id, u.last_sign_in_at
  FROM contractors c
  LEFT JOIN auth.users u ON c.user_id = u.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_contractor_last_logins() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_contractor_last_logins() TO authenticated;
