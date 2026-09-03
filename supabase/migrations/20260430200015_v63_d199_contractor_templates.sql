-- Migration: v63_d199_contractor_templates
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-04-30T20:00:15Z, recorded in
-- supabase_migrations.schema_migrations as version 20260430200015, name
-- "v63_d199_contractor_templates". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- D-199 Contract Template Validation Gate (April 30, 2026)
-- Tracks contractor PDF templates with anchor-validation status per trade × funding_type
-- 3-tier escalation: auto-validate → contractor manual mapping → Dustin admin review

-- New table: contractor_templates
CREATE TABLE IF NOT EXISTS public.contractor_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id UUID NOT NULL REFERENCES public.contractors(id) ON DELETE CASCADE,
  trade TEXT NOT NULL CHECK (trade IN ('roofing', 'siding', 'gutters', 'windows')),
  funding_type TEXT NOT NULL CHECK (funding_type IN ('retail', 'insurance')),
  pdf_storage_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_validation' CHECK (status IN (
    'pending_validation',
    'auto_validated',
    'manual_mapping_pending',
    'manual_validated',
    'submitted_for_admin_review',
    'admin_validated',
    'rejected'
  )),
  validation_result JSONB,
  manual_overrides JSONB,
  admin_notes TEXT,
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_active_template UNIQUE (contractor_id, trade, funding_type)
);

CREATE INDEX IF NOT EXISTS idx_contractor_templates_contractor
  ON public.contractor_templates(contractor_id);

CREATE INDEX IF NOT EXISTS idx_contractor_templates_status_pending
  ON public.contractor_templates(status)
  WHERE status IN ('pending_validation', 'submitted_for_admin_review');

-- New column: contractors.template_review_role (for Item 4 admin queue)
ALTER TABLE public.contractors
  ADD COLUMN IF NOT EXISTS template_review_role TEXT
  CHECK (template_review_role IS NULL OR template_review_role = 'admin');

COMMENT ON COLUMN public.contractors.template_review_role IS
  'D-199 Tier 3: contractors with template_review_role = ''admin'' can access admin-template-review.html. Pre-launch: Dustin only.';

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.contractor_templates_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contractor_templates_updated_at ON public.contractor_templates;
CREATE TRIGGER trg_contractor_templates_updated_at
  BEFORE UPDATE ON public.contractor_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.contractor_templates_set_updated_at();

-- RLS
ALTER TABLE public.contractor_templates ENABLE ROW LEVEL SECURITY;

-- Policy 1: contractors read/write their own templates
DROP POLICY IF EXISTS "contractor_templates_self" ON public.contractor_templates;
CREATE POLICY "contractor_templates_self" ON public.contractor_templates
  FOR ALL
  USING (
    contractor_id IN (
      SELECT id FROM public.contractors WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    contractor_id IN (
      SELECT id FROM public.contractors WHERE user_id = auth.uid()
    )
  );

-- Policy 2: admins (template_review_role = 'admin') read + update all
DROP POLICY IF EXISTS "contractor_templates_admin" ON public.contractor_templates;
CREATE POLICY "contractor_templates_admin" ON public.contractor_templates
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.contractors
      WHERE user_id = auth.uid()
        AND template_review_role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.contractors
      WHERE user_id = auth.uid()
        AND template_review_role = 'admin'
    )
  );

-- Service role bypass already handled by Supabase default RLS policies;
-- Edge Functions calling with service-role key are not restricted.

COMMENT ON TABLE public.contractor_templates IS
  'D-199 contract template anchor validation tracking. One row per contractor × trade × funding_type. Status state machine: pending_validation → auto_validated | manual_mapping_pending → manual_validated | submitted_for_admin_review → admin_validated | rejected.';
