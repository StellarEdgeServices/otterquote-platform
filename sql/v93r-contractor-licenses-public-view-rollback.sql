-- ============================================================================
-- Rollback v93r — remove homeowner-readable license data plumbing
-- Reverts: v93-contractor-licenses-public-view.sql
-- ============================================================================
-- 1. Drop the contractor_licenses_public view.
-- 2. Restore contractors_public to its v89 definition (drop the appended
--    license_doc_state column). CREATE OR REPLACE cannot remove columns, so
--    the view is dropped and recreated; grants are re-issued.
-- ============================================================================

BEGIN;

DROP VIEW IF EXISTS public.contractor_licenses_public;

DROP VIEW IF EXISTS public.contractors_public;

-- v89 definition, verbatim
CREATE VIEW public.contractors_public AS
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
  public_directory_optin
FROM public.contractors
WHERE status IN ('active', 'approved');

COMMENT ON VIEW public.contractors_public IS
'Public-safe projection of the contractors table for homeowner-facing pages. '
'Never exposes email, phone, Stripe fields, insurance policy numbers, COI, '
'contract templates, admin notes, or internal flags. '
'Filtered to status IN (''active'', ''approved''). Runs as postgres (owner) - '
'bypasses base-table RLS; the WHERE clause is the sole row gate. '
'Added by v89 migration (2026-06-13). See D-249 for column whitelist.';

GRANT SELECT ON public.contractors_public TO anon;
GRANT SELECT ON public.contractors_public TO authenticated;

COMMIT;
