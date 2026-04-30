-- D-204 Cert Verification Quality View (April 30, 2026)
-- Tracks D-204 manufacturer-cert verification system readiness for soft → hard filter flip.
-- Companion to ClickUp task with July 30, 2026 due date.
-- ClickUp build task: 86e15kx74

-- Forward-compatible schema: cert_status JSONB on contractors
-- Populated by future build task 86e15kx74 (D-204 cert verification system).
-- Shape (when populated): {"GAF Master Elite": {"verified_at": "2026-...", "source_url": "...", "verified_by": "scraper|admin"}, ...}
ALTER TABLE public.contractors
  ADD COLUMN IF NOT EXISTS cert_status JSONB;

COMMENT ON COLUMN public.contractors.cert_status IS
  'D-204 manufacturer-cert verification status per cert. Populated by build task 86e15kx74. Shape: {"<cert_name>": {"verified_at": ts, "source_url": str, "verified_by": "scraper"|"admin"}, ...}';

-- View: cert_verification_quality
-- Surfaces: bid volume since D-199 launch, contractors with cert claims, contractors with verified certs,
-- and a threshold flag for the morning briefing's "ready to flip" recommendation.
CREATE OR REPLACE VIEW public.cert_verification_quality
  WITH (security_invoker = on)
AS
SELECT
  (SELECT COUNT(*) FROM public.quotes WHERE created_at >= '2026-04-30'::date) AS total_bids_post_d199,
  (SELECT COUNT(*) FROM public.contractors
    WHERE cert_status IS NOT NULL AND cert_status::text != '{}') AS contractors_with_cert_claims,
  (SELECT COUNT(*) FROM public.contractors c
    WHERE c.cert_status IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_each(c.cert_status) AS j(cert_key, cert_val)
        WHERE cert_val ? 'verified_at'
      )
  ) AS contractors_with_verified_cert,
  (SELECT COUNT(*) FROM public.warranty_options
    WHERE cert_required IS NOT NULL AND active = true) AS active_cert_required_tiers,
  ((SELECT COUNT(*) FROM public.quotes WHERE created_at >= '2026-04-30'::date) >= 50) AS ready_for_hard_filter_review,
  CURRENT_TIMESTAMP AS computed_at;

COMMENT ON VIEW public.cert_verification_quality IS
  'D-204 trigger metric for soft → hard filter flip. Read by morning Executive Mode briefing. When ready_for_hard_filter_review = true AND verification accuracy ≥95%, surface flip recommendation.';
