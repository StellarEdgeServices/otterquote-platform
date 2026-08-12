-- ============================================================================
-- v109 — Replace contractors_public / referral_agents_public (SECURITY
-- DEFINER views, ERROR lint) with SECURITY DEFINER functions (GitHub #716,
-- follow-up to #530/#704's contractor_licenses_public fix). These were the
-- last 2 security_definer_view ERROR findings in the project.
-- ============================================================================
--
-- Same fix pattern as #704 (contractor_licenses_public -> get_contractor_
-- licenses_public): function + explicit REVOKE/GRANT + call-site flip +
-- DROP VIEW, but sequenced as two DISTINCT applied phases (not one atomic
-- migration) specifically to avoid the atomicity failure #704's postmortem
-- flagged — dropping a view in the same instant a DB migration applies
-- creates an outage window for any homeowner/partner hitting the page before
-- the paired Netlify app deploy (which takes minutes, not zero) has gone
-- live, because the DB migration takes effect instantly while the old
-- .from(view) call sites are still deployed and would start erroring.
--
-- PHASE 1 (additive, applied immediately, non-destructive):
--   Create get_contractors_public() and get_referral_agents_public().
--   Verified byte-for-byte parity with the views' prior REST behavior via
--   curl against the live PostgREST endpoint (GET+filter+select, subset
--   select, select=*, .in(), .contains()+.limit(), and POST-verb RPC calls
--   — the shapes every real call site in the repo actually used) BEFORE any
--   call site was touched.
--
-- PHASE 2 (destructive, applied only after the paired call-site PR is
--   merged AND deployed to Netlify — see PR for this issue):
--   DROP the two views. Every call site (23 occurrences across 20 files —
--   both static HTML and the React app) was already switched from
--   `.from('<view>')` to `.rpc('get_<view>')` in that same PR; PostgREST/
--   supabase-js support the identical .select()/.eq()/.in()/.contains()/
--   .limit()/.single()/.maybeSingle() chaining against a STABLE
--   TABLE-returning function as it does against a view, so no call site's
--   filter/select shape needed to change — only the `.from`/`.rpc` verb.
--
-- contractors_public has a materially larger call-site surface than
-- contractor_licenses_public (13 files) and was NOT a copy-paste of that
-- fix: contractors/referral_agents have NO RLS policy granting anon/
-- authenticated SELECT on active/approved rows (verified via pg_policies
-- before writing this), so recreating the views with `security_invoker =
-- true` instead of a function would have returned zero rows to every
-- anon-facing page (bids, repair-intake, project-confirmation, contractor-
-- about, all ref*/partner* landing pages, trade-selector) — the function
-- approach preserves the exact intentional RLS-bypass posture the original
-- views documented ("Runs as postgres (owner) - bypasses base-table RLS;
-- the WHERE clause is the sole row gate").
--
-- Rollback: sql/v109-rollback-contractors-referral-agents-public-security-
--   invoker.sql. Does not revert call sites — an app-side rollback (all 20
--   files back to `.from(view)`) must ship alongside it, same caveat as
--   #704/v106.
-- ============================================================================

-- ── PHASE 1 (already applied 2026-08-12 via apply_migration, see PR) ──────
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

-- ── PHASE 2 (apply ONLY after this PR's call-site changes are merged AND
--   the Netlify deploy carrying them is confirmed live — expand/contract,
--   not drop-then-recreate) ──────────────────────────────────────────────
BEGIN;

DROP VIEW IF EXISTS public.contractors_public;
DROP VIEW IF EXISTS public.referral_agents_public;

COMMIT;
