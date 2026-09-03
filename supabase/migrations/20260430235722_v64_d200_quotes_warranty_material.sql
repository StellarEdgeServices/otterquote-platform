-- Migration: v64_d200_quotes_warranty_material
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-04-30T23:57:22Z, recorded in
-- supabase_migrations.schema_migrations as version 20260430235722, name
-- "v64_d200_quotes_warranty_material". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v64 — D-200 + D-202 quote schema additions for create-docusign-envelope deep clean.
-- Adds the FK + snapshot needed to render Manufacturer's Warranty: anchor and the
-- Material Selection block on the retail Exhibit A SOW.

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
  'D-200 §3 — JSONB snapshot of Material Selection block (per category: Brand/ProductLine/Type/Color or Generic).';
COMMENT ON COLUMN public.quotes.workmanship_warranty_years IS
  'D-202 — Contractor-specified workmanship years. Auto-fills Workmanship Warranty: anchor.';
