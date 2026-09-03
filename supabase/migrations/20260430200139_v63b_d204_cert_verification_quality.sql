-- Migration: v63b_d204_cert_verification_quality
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-04-30T20:01:39Z, recorded in
-- supabase_migrations.schema_migrations as version 20260430200139, name
-- "v63b_d204_cert_verification_quality". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- D-204 Cert Verification Quality View (April 30, 2026)
-- Tracks D-204 manufacturer-cert verification system readiness for soft → hard filter flip.
-- Companion to ClickUp task with July 30, 2026 due date.

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
-- Threshold: 50+ post-D-199 bids → flag review. Combined with July 30, 2026 ClickUp task, prevents the
-- "we forgot to flip soft → hard" failure mode.
CREATE OR REPLACE VIEW public.cert_verification_quality
  WITH (security_invoker = on)
AS
SELECT
  -- Total bids since D-199 cert architecture decision (April 30, 2026)
  (SELECT COUNT(*) FROM public.quotes WHERE created_at >= '2026-04-30'::date) AS total_bids_post_d199,
  -- Contractors with any cert claim (cert_status populated, non-empty)
  (SELECT COUNT(*) FROM public.contractors
    WHERE cert_status IS NOT NULL AND cert_status::text != '{}') AS contractors_with_cert_claims,
  -- Contractors with at least one verified cert (any value with verified_at set)
  (SELECT COUNT(*) FROM public.contractors c
    WHERE c.cert_status IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_each(c.cert_status) AS j(cert_key, cert_val)
        WHERE cert_val ? 'verified_at'
      )
  ) AS contractors_with_verified_cert,
  -- Bids selecting a warranty tier that requires cert (data link added when D-204 build lands)
  -- For now, this counts based on warranty_options table; once quotes.warranty_options_id FK exists
  -- (planned in 86e15kx74), update this view to JOIN through.
  (SELECT COUNT(*) FROM public.warranty_options
    WHERE cert_required IS NOT NULL AND active = true) AS active_cert_required_tiers,
  -- Threshold flag for morning briefing: "ready to flip soft → hard filter review"
  -- Trigger: 50+ post-D-199 bids
  ((SELECT COUNT(*) FROM public.quotes WHERE created_at >= '2026-04-30'::date) >= 50) AS ready_for_hard_filter_review,
  -- Computed timestamp
  CURRENT_TIMESTAMP AS computed_at;

COMMENT ON VIEW public.cert_verification_quality IS
  'D-204 trigger metric for soft → hard filter flip. Read by morning Executive Mode briefing. When ready_for_hard_filter_review = true AND verification accuracy ≥95%, surface flip recommendation.';
