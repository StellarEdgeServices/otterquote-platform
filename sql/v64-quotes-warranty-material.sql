-- v64 — D-200 + D-202 quote schema additions for create-docusign-envelope deep clean.
-- Adds the FK + snapshot needed to render Manufacturer's Warranty: anchor and the
-- Material Selection block on the retail Exhibit A SOW.
--
-- Applied: April 30, 2026 (Session 462)
-- ClickUp: 86e153vw6
-- Companion rollback: sql/v64-rollback.sql

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS warranty_option_id UUID NULL
    REFERENCES public.warranty_options(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS warranty_snapshot TEXT NULL,
  ADD COLUMN IF NOT EXISTS material_selection JSONB NULL,
  ADD COLUMN IF NOT EXISTS workmanship_warranty_years INTEGER NULL;

CREATE INDEX IF NOT EXISTS idx_quotes_warranty_option_id
  ON public.quotes(warranty_option_id)
  WHERE warranty_option_id IS NOT NULL;

COMMENT ON COLUMN public.quotes.warranty_option_id IS
  'D-202 — FK to warranty_options. Auto-populates Manufacturers Warranty anchor on contractor PDF.';
COMMENT ON COLUMN public.quotes.warranty_snapshot IS
  'D-202 — Frozen warranty_options.display_string at time of bid. Insulates signed contracts from manifest edits.';
COMMENT ON COLUMN public.quotes.material_selection IS
  'D-200 Section 3 — JSONB snapshot of Material Selection block (per category: Brand/ProductLine/Type/Color or Generic).';
COMMENT ON COLUMN public.quotes.workmanship_warranty_years IS
  'D-202 — Contractor-specified workmanship years. Auto-fills Workmanship Warranty: anchor.';
