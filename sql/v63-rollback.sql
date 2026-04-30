-- ROLLBACK for v63_d199_contractor_templates
-- Reverses everything applied April 30, 2026
-- WARNING: this drops the contractor_templates table and any data it contains.
-- Pre-rollback: SELECT * FROM public.contractor_templates;  -- export if needed

-- 1) Drop policies
DROP POLICY IF EXISTS "contractor_templates_admin" ON public.contractor_templates;
DROP POLICY IF EXISTS "contractor_templates_self" ON public.contractor_templates;

-- 2) Drop trigger + function
DROP TRIGGER IF EXISTS trg_contractor_templates_updated_at ON public.contractor_templates;
DROP FUNCTION IF EXISTS public.contractor_templates_set_updated_at();

-- 3) Drop the table (cascades to indexes)
DROP TABLE IF EXISTS public.contractor_templates;

-- 4) Drop the new column on contractors
ALTER TABLE public.contractors
  DROP COLUMN IF EXISTS template_review_role;
