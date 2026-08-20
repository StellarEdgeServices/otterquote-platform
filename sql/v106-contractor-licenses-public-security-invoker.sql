-- ============================================================================
-- v106 — Replace contractor_licenses_public (SECURITY DEFINER view, ERROR
-- lint) with a SECURITY DEFINER function (GitHub #530, 4th view found by
-- the 2026-08-08 advisor re-run)
-- ============================================================================
--
-- APPROVED atomically by Dustin, issue comment 5252851924 — function + GRANT/
-- REVOKE + DROP VIEW + both call-site diffs ship together. contractor_licenses
-- has no anon-facing SELECT policy (own-record / admin-by-email / service_role
-- only); this function exposes a curated, non-PII column subset to anon,
-- filtered to active/approved contractors, mirroring the view's prior RLS
-- bypass intentionally rather than accidentally.
--
-- REQUIRED AMENDMENT (Dustin, same comment): the original draft's bare GRANT
-- relied on Supabase's default privileges (new SECURITY DEFINER functions in
-- public auto-grant EXECUTE to anon/authenticated/service_role) rather than
-- an explicit, verified grant — migration-author danger pattern #9. Fixed
-- here with an explicit REVOKE before the GRANT.
--
-- Rollback: sql/v106-rollback-contractor-licenses-public-security-invoker.sql
-- ============================================================================

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
