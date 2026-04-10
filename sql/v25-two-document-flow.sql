-- ============================================================
-- OtterQuote v25 Migration: Two-Document Flow (D-110 through D-114)
-- Applied: April 10, 2026 — Session 104
-- Purpose: Add data model support for the project confirmation
--          document — the second signed document in the two-doc flow.
--          Contract (doc 1) is signed first for zero-friction revenue.
--          Project confirmation (doc 2) captures full scope + color data.
-- ============================================================

-- 1. Add project_confirmation JSONB to claims table
--    Stores all structured scope/color data captured in the
--    project confirmation document (D-111: structures, trades,
--    shingle details, skylights, chimney, work authorizations).
ALTER TABLE claims ADD COLUMN IF NOT EXISTS project_confirmation JSONB;

-- GIN index for efficient JSONB queries on project confirmation data
CREATE INDEX IF NOT EXISTS idx_claims_project_confirmation
    ON claims USING gin(project_confirmation);

-- 2. Add color_confirmation_template TEXT to contractors table
--    Stores the Storage URL for the contractor's uploaded project
--    confirmation PDF template. Single URL (unlike contract_templates
--    which is a JSONB array of trade/funding-type slots).
--    Template stored in contractor-templates Storage bucket.
--    Falls back to color addendum behavior until contractor uploads.
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS color_confirmation_template TEXT;
