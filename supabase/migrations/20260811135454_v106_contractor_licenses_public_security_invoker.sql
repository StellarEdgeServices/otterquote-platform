-- Migration: v106_contractor_licenses_public_security_invoker
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-11T13:54:54Z, recorded in
-- supabase_migrations.schema_migrations as version 20260811135454, name
-- "v106_contractor_licenses_public_security_invoker". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_contractor_licenses_public(p_contractor_ids uuid[])
RETURNS TABLE (
  contractor_id uuid,
  jurisdiction_level text,
  municipality text,
  license_number text,
  expiration_date date,
  verification_url text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT cl.contractor_id, cl.jurisdiction_level, cl.municipality, cl.license_number,
         cl.expiration_date, cl.verification_url
  FROM contractor_licenses cl
  WHERE cl.contractor_id = ANY(p_contractor_ids)
    AND cl.contractor_id IN (
      SELECT id FROM contractors WHERE status = ANY(ARRAY['active','approved'])
    );
$$;

REVOKE ALL ON FUNCTION public.get_contractor_licenses_public(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_contractor_licenses_public(uuid[]) TO anon, authenticated;

DROP VIEW IF EXISTS public.contractor_licenses_public;

COMMIT;
