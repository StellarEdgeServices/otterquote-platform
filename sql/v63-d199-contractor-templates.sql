-- D-199 Contract Template Validation Gate (April 30, 2026)
-- Tracks contractor PDF templates with anchor-validation status per trade × funding_type
-- 3-tier escalation: auto-validate → contractor manual mapping → Dustin admin review
-- ClickUp: 86e15abkr · Decision: D-199 · Approved manifest: docs/D-199-D-202-design-artifacts/D-199-anchor-manifest-v2.md

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

COMMENT ON TABLE public.contractor_templates IS
  'D-199 contract template anchor validation tracking. One row per contractor × trade × funding_type. Status state machine: pending_validation → auto_validated | manual_mapping_pending → manual_validated | submitted_for_admin_review → admin_validated | rejected.';
