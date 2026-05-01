-- v64 rollback — drops the four columns and FK index added by v64-quotes-warranty-material.sql.
-- Safe to run only if no production data depends on these columns.
-- Pre-revenue as of Session 462; rollback is non-destructive.

DROP INDEX IF EXISTS public.idx_quotes_warranty_option_id;

ALTER TABLE public.quotes
  DROP COLUMN IF EXISTS workmanship_warranty_years,
  DROP COLUMN IF EXISTS material_selection,
  DROP COLUMN IF EXISTS warranty_snapshot,
  DROP COLUMN IF EXISTS warranty_option_id;
