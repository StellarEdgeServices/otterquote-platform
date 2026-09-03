-- Migration: v69_d202_warranty_manifest_drift
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-01T21:56:12Z, recorded in
-- supabase_migrations.schema_migrations as version 20260501215612, name
-- "v69_d202_warranty_manifest_drift". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

CREATE TABLE IF NOT EXISTS public.warranty_manifest_drift (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  refresh_run_id      UUID NOT NULL,
  detected_at         TIMESTAMPTZ DEFAULT now() NOT NULL,
  manufacturer        TEXT NOT NULL,
  tier                TEXT NOT NULL,
  warranty_option_id  UUID REFERENCES public.warranty_options(id) ON DELETE SET NULL,
  current_value       JSONB NOT NULL,
  proposed_value      JSONB,
  change_type         TEXT NOT NULL CHECK (change_type IN ('modified', 'added', 'deprecated', 'no_source')),
  source_url          TEXT,
  status              TEXT NOT NULL DEFAULT 'pending_review'
                        CHECK (status IN ('pending_review', 'approved', 'rejected', 'applied', 'skipped')),
  rejection_reason    TEXT,
  reviewed_by         TEXT,
  reviewed_at         TIMESTAMPTZ,
  applied_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS warranty_manifest_drift_status_detected_at_idx
  ON public.warranty_manifest_drift (status, detected_at DESC);

CREATE INDEX IF NOT EXISTS warranty_manifest_drift_refresh_run_id_idx
  ON public.warranty_manifest_drift (refresh_run_id);

CREATE INDEX IF NOT EXISTS warranty_manifest_drift_manufacturer_tier_status_idx
  ON public.warranty_manifest_drift (manufacturer, tier, status);

ALTER TABLE public.warranty_manifest_drift ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
  ON public.warranty_manifest_drift
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Admin read"
  ON public.warranty_manifest_drift
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.contractors c
      WHERE c.user_id = auth.uid()
        AND c.template_review_role = 'admin'
    )
    OR (
      SELECT email FROM auth.users WHERE id = auth.uid()
    ) = 'dustinstohler1@gmail.com'
  );

COMMENT ON TABLE public.warranty_manifest_drift IS
  'D-202: Quarterly warranty manifest refresh audit log. Stores proposed changes detected '
  'by the refresh-warranty-manifest Edge Function. Admin-gated change control — no '
  'autonomous edits to warranty_options. Status: pending_review → approved/rejected/skipped → applied.';
