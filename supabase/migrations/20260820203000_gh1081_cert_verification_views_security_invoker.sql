-- gh-1081: Convert cert_verification_quality views to SECURITY INVOKER
--
-- Background:
--   The baseline schema (20260101000000_v000_baseline_schema.sql) created
--   public.cert_verification_quality and
--   public.cert_verification_quality_by_manufacturer as default views
--   (SECURITY DEFINER) with no auth.uid() anchoring inside the view body.
--   Both views read from quotes, contractors, warranty_options, and
--   contractor_cert_verifications — tables that contain business-sensitive
--   bid and certification data.
--
--   The gh-1028 migration (20260818205500) rebuilt them to filter is_test
--   rows but did NOT add security_invoker = on, so they remain SECURITY
--   DEFINER — a defnitely authenticated role (e.g. "service_role" or the
--   view owner) could read all rows, and the views grant broad default
--   access via Supabase default privileges (anon/authenticated SELECT).
--
-- Fix:
--   Add WITH (security_invoker = true) so the views execute with the
--   calling role's permissions, and apply explicit REVOKE/GRANT matching
--   the v113_derived_role_view.sql pattern:
--     REVOKE ALL FROM PUBLIC, anon
--     GRANT SELECT TO authenticated
--
--   Underlying tables already have RLS policies scoped by auth.uid() or
--   service-level checks, so security_invoker + RLS ensures callers can
--   only see rows their own role is permitted to read.
--
-- Rollback: CREATE OR REPLACE VIEW without the WITH clause (restores
--   SECURITY DEFINER default) and re-grants PUBLIC.

BEGIN;

-- 1. cert_verification_quality -------------------------------------------------

CREATE OR REPLACE VIEW public.cert_verification_quality
WITH (security_invoker = true)
AS
  SELECT ( SELECT count(*) AS count
           FROM quotes
          WHERE quotes.created_at >= '2026-04-30'::date AND quotes.is_test = false) AS total_bids_post_d199,
     ( SELECT count(*) AS count
         FROM contractors
        WHERE contractors.cert_status IS NOT NULL AND contractors.cert_status::text <> '{}'::text) AS contractors_with_cert_claims,
     ( SELECT count(*) AS count
         FROM contractors c
        WHERE c.cert_status IS NOT NULL AND (EXISTS ( SELECT 1
                   FROM jsonb_each(c.cert_status) j(cert_key, cert_val)
                  WHERE j.cert_val ? 'verified_at'::text))) AS contractors_with_verified_cert,
     ( SELECT count(*) AS count
         FROM warranty_options
        WHERE warranty_options.cert_required IS NOT NULL AND warranty_options.active = true) AS active_cert_required_tiers,
     (( SELECT count(*) AS count
           FROM quotes
          WHERE quotes.created_at >= '2026-04-30'::date AND quotes.is_test = false) >= 50) AS ready_for_hard_filter_review,
     CURRENT_TIMESTAMP AS computed_at;

COMMENT ON VIEW public.cert_verification_quality IS
  'D-204 trigger metric for soft -> hard filter flip. SECURITY INVOKER. '
  'Read by morning Executive Mode briefing. Requires RLS-backed access on '
  'quotes / contractors / warranty_options / contractor_cert_verifications.';

REVOKE ALL ON public.cert_verification_quality FROM PUBLIC;
REVOKE ALL ON public.cert_verification_quality FROM anon;
GRANT SELECT ON public.cert_verification_quality TO authenticated;

-- 2. cert_verification_quality_by_manufacturer --------------------------------

CREATE OR REPLACE VIEW public.cert_verification_quality_by_manufacturer
WITH (security_invoker = true)
AS
  WITH mfrs AS (
          SELECT DISTINCT warranty_options.manufacturer
            FROM warranty_options
           WHERE warranty_options.active = true
         ), verified_contractors AS (
          SELECT contractor_cert_verifications.manufacturer,
             count(DISTINCT contractor_cert_verifications.contractor_id) AS contractors_verified_count
            FROM contractor_cert_verifications
           WHERE contractor_cert_verifications.status = 'verified'::text
           GROUP BY contractor_cert_verifications.manufacturer
         ), last_scrape AS (
          SELECT contractor_cert_verifications.manufacturer,
             max(contractor_cert_verifications.verified_at) AS last_successful_scrape_at
            FROM contractor_cert_verifications
           WHERE contractor_cert_verifications.status = 'verified'::text AND contractor_cert_verifications.source = 'public_lookup'::text
           GROUP BY contractor_cert_verifications.manufacturer
         ), bids_30d AS (
          SELECT wo.manufacturer,
             count(*) AS bids_30d_count,
             count(*) FILTER (WHERE (EXISTS ( SELECT 1
                    FROM contractor_cert_verifications ccv
                   WHERE ccv.contractor_id = q.contractor_id AND ccv.manufacturer = wo.manufacturer AND ccv.status = 'verified'::text))) AS bids_30d_with_verified_cert_count
            FROM quotes q
              JOIN warranty_options wo ON wo.id = q.warranty_option_id
           WHERE q.created_at >= (now() - '30 days'::interval) AND q.warranty_option_id IS NOT NULL AND q.is_test = false
           GROUP BY wo.manufacturer
         )
  SELECT m.manufacturer,
     COALESCE(vc.contractors_verified_count, 0::bigint) AS contractors_verified_count,
     COALESCE(b.bids_30d_count, 0::bigint) AS bids_30d_count,
     COALESCE(b.bids_30d_with_verified_cert_count, 0::bigint) AS bids_30d_with_verified_cert_count,
         CASE
             WHEN COALESCE(b.bids_30d_count, 0::bigint) = 0 THEN NULL::numeric
             ELSE round(100.0 * b.bids_30d_with_verified_cert_count::numeric / b.bids_30d_count::numeric, 1)
         END AS verification_coverage_pct,
     ls.last_successful_scrape_at,
         CASE
             WHEN ls.last_successful_scrape_at IS NULL THEN NULL::integer
             ELSE EXTRACT(day FROM now() - ls.last_successful_scrape_at)::integer
         END AS days_since_last_scrape
    FROM mfrs m
      LEFT JOIN verified_contractors vc USING (manufacturer)
      LEFT JOIN last_scrape ls USING (manufacturer)
      LEFT JOIN bids_30d b USING (manufacturer);

COMMENT ON VIEW public.cert_verification_quality_by_manufacturer IS
  'D-204 per-manufacturer cert verification metrics. SECURITY INVOKER. '
  'Read by morning Executive Mode briefing. Requires RLS-backed access on '
  'quotes / contractors / warranty_options / contractor_cert_verifications.';

REVOKE ALL ON public.cert_verification_quality_by_manufacturer FROM PUBLIC;
REVOKE ALL ON public.cert_verification_quality_by_manufacturer FROM anon;
GRANT SELECT ON public.cert_verification_quality_by_manufacturer TO authenticated;

-- 3. Sync the legacy sql/ files to match (documentation-only; not executed by Supabase) ----
-- Note: the sql/ files are hand-run scripts, not auto-migrated. This comment
-- records that sql/v63b-d204-cert-verification-quality.sql already had the
-- correct WITH (security_invoker = on) — the Supabase migration simply
-- never picked up that fix. This migration brings them in line.

COMMIT;
