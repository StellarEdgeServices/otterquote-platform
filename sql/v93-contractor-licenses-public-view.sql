-- ============================================================================
-- Migration v93 — homeowner-readable license data (D-217/D-218, issue #534)
-- Created: 2026-07-13
-- ============================================================================
-- Problem:
--   The #534 credential-education popup on bids.html must display D-218
--   multi-license data (jurisdiction, license #, expiry, verification_url)
--   to homeowners, plus the D-217 "License not provided" state driven by
--   contractors.license_path. But:
--     - contractor_licenses RLS only grants SELECT to the owning contractor,
--       the admin email, and service_role - homeowner reads return no rows
--       (contractor-about.html:518 already hits this and silently falls back).
--     - license_path is excluded from contractors_public by the v89/D-249
--       whitelist (it is a storage path - never expose raw).
--
-- Decision (additive only - Tier 3A, v89 pattern):
--   1. contractor_licenses_public view: homeowner-safe license columns only
--      (no license_document_url storage path, no internal verified flag),
--      restricted to contractors already visible through contractors_public
--      (status IN ('active','approved')). Postgres-owned -> bypasses base
--      RLS; the WHERE clause is the sole row gate (same posture as v89).
--   2. contractors_public: append derived license_doc_state
--      ('uploaded' | 'not_provided' | NULL) - the D-217/D-218 display flag
--      without exposing the raw license_path storage path. CREATE OR REPLACE
--      appends the column at the end (no existing columns change).
--
-- Rollback: v93r-contractor-licenses-public-view-rollback.sql
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Homeowner-safe license drill-down (D-218)
-- ============================================================================
CREATE OR REPLACE VIEW public.contractor_licenses_public AS
SELECT
  cl.contractor_id,
  cl.jurisdiction_level,   -- state / county / city / other
  cl.municipality,
  cl.license_number,
  cl.expiration_date,
  cl.verification_url
FROM public.contractor_licenses cl
WHERE cl.contractor_id IN (
  SELECT id FROM public.contractors WHERE status IN ('active', 'approved')
);

COMMENT ON VIEW public.contractor_licenses_public IS
'Homeowner-safe projection of contractor_licenses for the bids.html / React '
'credential-education surfaces (D-217/D-218, issue #534). Excludes '
'license_document_url (storage path) and the internal verified flag. Rows '
'limited to contractors with status IN (''active'', ''approved'') - the same '
'gate as contractors_public. Postgres-owned; bypasses base-table RLS - the '
'WHERE clause is the sole row gate. Added by v93 migration (2026-07-13).';

GRANT SELECT ON public.contractor_licenses_public TO anon;
GRANT SELECT ON public.contractor_licenses_public TO authenticated;

-- ============================================================================
-- 2. contractors_public + derived license_doc_state (appended column)
--    Column list is v89 verbatim; only the CASE expression is new.
-- ============================================================================
CREATE OR REPLACE VIEW public.contractors_public AS
SELECT
  id,
  company_name,
  contact_name,
  address_city,
  address_state,
  trades,
  specialties,
  rating,
  review_count,
  years_in_business,
  num_employees,
  about_us,
  why_choose_us,
  owner_photo_url,
  gallery_photo_urls,
  intro_video_path,
  service_area_description,
  service_counties,
  verified,
  has_workers_comp,
  has_general_liability,
  license_number,
  google_reviews_url,
  bbb_url,
  angi_url,
  yelp_url,
  website_url,
  status,
  repairs_accepted,
  public_directory_optin,
  -- D-217/D-218 display flag (v93). Derived so the raw storage path in
  -- license_path stays unexposed per the v89/D-249 whitelist:
  --   'not_provided' -> contractor attested no license (pre-approval sentinel)
  --   'uploaded'     -> a license document path exists on the contractor row
  --   NULL           -> nothing recorded either way (renders as not provided)
  CASE
    WHEN license_path = 'not_provided' THEN 'not_provided'
    WHEN license_path IS NOT NULL THEN 'uploaded'
  END AS license_doc_state
FROM public.contractors
WHERE status IN ('active', 'approved');

COMMENT ON VIEW public.contractors_public IS
'Public-safe projection of the contractors table for homeowner-facing pages. '
'Never exposes email, phone, Stripe fields, insurance policy numbers, COI, '
'contract templates, admin notes, or internal flags. '
'Filtered to status IN (''active'', ''approved''). Runs as postgres (owner) - '
'bypasses base-table RLS; the WHERE clause is the sole row gate. '
'Added by v89 migration (2026-06-13); license_doc_state (derived, no raw '
'path) appended by v93 (2026-07-13). See D-249 for column whitelist.';

COMMIT;
