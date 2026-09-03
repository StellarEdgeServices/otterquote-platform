-- Migration: v109_contractors_referral_agents_public_security_invoker_phase1_functions
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-08-12T13:17:07Z, recorded in
-- supabase_migrations.schema_migrations as version 20260812131707, name
-- "v109_contractors_referral_agents_public_security_invoker_phase1_functions".
-- NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- ============================================================================
-- v109 PHASE 1 — Additive: create get_contractors_public() and
-- get_referral_agents_public() SECURITY DEFINER functions to replace the
-- security_definer_view-flagged contractors_public / referral_agents_public
-- views (GitHub #716, follow-up to #530/#704's contractor_licenses_public fix).
--
-- This phase does NOT touch or drop the existing views. Expand/contract:
-- create the new callable surface first, validate it, switch every call site
-- to it, ship + deploy that, THEN (phase 2, separate migration) drop the
-- views. #704's postmortem flagged an atomicity failure from dropping a view
-- in the same migration as call-site code that hasn't finished deploying yet
-- (DB migration applies instantly; Netlify app deploy takes minutes) — this
-- phase split avoids repeating that.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_contractors_public()
RETURNS TABLE (
  id uuid,
  company_name text,
  contact_name text,
  address_city text,
  address_state text,
  trades text[],
  specialties text[],
  rating numeric,
  review_count integer,
  years_in_business integer,
  num_employees text,
  about_us text,
  why_choose_us text,
  owner_photo_url text,
  gallery_photo_urls text[],
  intro_video_path text,
  service_area_description text,
  service_counties text[],
  verified boolean,
  has_workers_comp boolean,
  has_general_liability boolean,
  license_number text,
  google_reviews_url text,
  bbb_url text,
  angi_url text,
  yelp_url text,
  website_url text,
  status text,
  repairs_accepted boolean,
  public_directory_optin boolean,
  license_doc_state text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT id, company_name, contact_name, address_city, address_state, trades, specialties,
         rating, review_count, years_in_business, num_employees, about_us, why_choose_us,
         owner_photo_url, gallery_photo_urls, intro_video_path, service_area_description,
         service_counties, verified, has_workers_comp, has_general_liability, license_number,
         google_reviews_url, bbb_url, angi_url, yelp_url, website_url, status, repairs_accepted,
         public_directory_optin,
         CASE
           WHEN license_path = 'not_provided' THEN 'not_provided'
           WHEN license_path IS NOT NULL THEN 'uploaded'
           ELSE NULL
         END AS license_doc_state
  FROM public.contractors
  WHERE status = ANY (ARRAY['active','approved']);
$$;

COMMENT ON FUNCTION public.get_contractors_public() IS
'SECURITY DEFINER replacement for the contractors_public view (GitHub #716). '
'Returns the same rows/columns the view returned (status IN (active,approved)); '
'runs as postgres (owner), bypassing base-table RLS intentionally — the WHERE '
'clause is the sole row gate, same posture as the original view. Marked STABLE '
'so PostgREST exposes it via GET and supports the same .select()/.eq()/.order() '
'chaining supabase-js applied to the view.';

REVOKE ALL ON FUNCTION public.get_contractors_public() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_contractors_public() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_referral_agents_public()
RETURNS TABLE (
  id uuid,
  first_name text,
  last_name text,
  company text,
  photo_url text,
  bio text,
  website text,
  service_area text,
  agent_type text,
  status text,
  unique_code text,
  recruit_code text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT id, first_name, last_name, company, photo_url, bio, website, service_area,
         agent_type, status, unique_code, recruit_code
  FROM public.referral_agents
  WHERE status = 'active';
$$;

COMMENT ON FUNCTION public.get_referral_agents_public() IS
'SECURITY DEFINER replacement for the referral_agents_public view (GitHub #716). '
'Returns the same rows/columns the view returned (status = active); runs as '
'postgres (owner), bypassing base-table RLS intentionally — the WHERE clause is '
'the sole row gate, same posture as the original view. Marked STABLE so '
'PostgREST exposes it via GET and supports the same .select()/.eq()/.order() '
'chaining supabase-js applied to the view.';

REVOKE ALL ON FUNCTION public.get_referral_agents_public() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_referral_agents_public() TO anon, authenticated;

COMMIT;
