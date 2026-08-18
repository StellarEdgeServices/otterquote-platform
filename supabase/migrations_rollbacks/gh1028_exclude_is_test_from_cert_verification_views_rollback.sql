-- Rollback for: 20260818205500_gh1028_exclude_is_test_from_cert_verification_views.sql
-- GitHub: #1028
-- Restores both views to their pre-#1028 definitions (no is_test filter).

BEGIN;

CREATE OR REPLACE VIEW public.cert_verification_quality AS
 SELECT ( SELECT count(*) AS count
        FROM quotes
       WHERE quotes.created_at >= '2026-04-30'::date) AS total_bids_post_d199,
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
       WHERE quotes.created_at >= '2026-04-30'::date) >= 50) AS ready_for_hard_filter_review,
    CURRENT_TIMESTAMP AS computed_at;

CREATE OR REPLACE VIEW public.cert_verification_quality_by_manufacturer AS
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
          WHERE q.created_at >= (now() - '30 days'::interval) AND q.warranty_option_id IS NOT NULL
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

COMMIT;
