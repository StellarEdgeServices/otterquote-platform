-- ============================================================================
-- v109 ROLLBACK — restores contractors_public / referral_agents_public as
-- views, body verbatim from pg_get_viewdef() captured against the live
-- production database immediately before this migration ran (contractors_
-- public includes the v93 license_doc_state column; referral_agents_public
-- has NO public_directory_optin column — that column exists on the
-- referral_agents base TABLE only, per v101, and is read directly by
-- tools/generate_partner_pages.py via service_role, never through this
-- view) — and drops get_contractors_public() / get_referral_agents_public()
-- (GitHub #716)
-- ============================================================================
--
-- Does not restore call sites — the app-side rollback (reverting all 20
-- files' .rpc('get_<view>') calls back to .from('<view>')) must ship in the
-- same revert as this SQL, or the app will call a view that exists but a
-- function that no longer does, or vice versa. Same caveat as v106/#704.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.get_contractors_public();
DROP FUNCTION IF EXISTS public.get_referral_agents_public();

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
  CASE
    WHEN license_path = 'not_provided' THEN 'not_provided'
    WHEN license_path IS NOT NULL THEN 'uploaded'
    ELSE NULL
  END AS license_doc_state
FROM public.contractors
WHERE status = ANY (ARRAY['active','approved']);

COMMENT ON VIEW public.contractors_public IS
'Public-safe projection of the contractors table for homeowner-facing pages. '
'Never exposes email, phone, Stripe fields, insurance policy numbers, COI, '
'contract templates, admin notes, or internal flags. '
'Filtered to status IN (''active'', ''approved''). Runs as postgres (owner) - '
'bypasses base-table RLS; the WHERE clause is the sole row gate. '
'Restored by the v109 rollback (GitHub #716) after the v109 security_invoker '
'migration converted it to get_contractors_public().';

GRANT SELECT ON public.contractors_public TO anon;
GRANT SELECT ON public.contractors_public TO authenticated;

CREATE OR REPLACE VIEW public.referral_agents_public AS
SELECT
  id,
  first_name,
  last_name,
  company,
  photo_url,
  bio,
  website,
  service_area,
  agent_type,
  status,
  unique_code,
  recruit_code
FROM public.referral_agents
WHERE status = 'active';

COMMENT ON VIEW public.referral_agents_public IS
'Public-safe projection of the referral_agents table for partner landing '
'pages / recruit-code lookups. Never exposes email, phone, or financial '
'fields. Filtered to status = ''active''. Runs as postgres (owner) - bypasses '
'base-table RLS; the WHERE clause is the sole row gate. Restored by the v109 '
'rollback (GitHub #716) after the v109 security_invoker migration converted '
'it to get_referral_agents_public().';

GRANT SELECT ON public.referral_agents_public TO anon;
GRANT SELECT ON public.referral_agents_public TO authenticated;

COMMIT;
