-- v43: Project Confirmation Template Grid (D-161)
-- Converts color_confirmation_template from a single TEXT URL to a JSONB
-- object with 8 slots (4 trades × 2 funding types), matching the existing
-- contract_templates JSONB pattern.
--
-- Migration strategy:
--   Any existing TEXT value (always a full public URL from the old single-upload
--   card) is migrated into the roofing/insurance slot — the most common trade
--   for contractors who had already uploaded a template. The contractor will be
--   flagged via pc_template_migration_pending so Dustin can nudge them to
--   redistribute their template to the correct slot(s).
--
-- Applied: April 19, 2026 — Session 246

-- Step 1: Cast TEXT → JSONB, preserving any existing URL in roofing/insurance slot
ALTER TABLE contractors
  ALTER COLUMN color_confirmation_template
    TYPE JSONB
    USING CASE
      WHEN color_confirmation_template IS NULL THEN NULL
      ELSE jsonb_build_object(
        'roofing/insurance',
        jsonb_build_object(
          'file_url',    color_confirmation_template,
          'uploaded_at', COALESCE(updated_at, NOW())
        )
      )
    END;

-- Step 2: Add migration-pending flag (default FALSE — only existing uploads get TRUE)
ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS pc_template_migration_pending BOOLEAN DEFAULT FALSE;

-- Step 3: Flag any contractor whose template was just migrated from the old TEXT value
--         (i.e., the JSONB is non-null after the cast — meaning they had a template)
UPDATE contractors
SET    pc_template_migration_pending = TRUE
WHERE  color_confirmation_template IS NOT NULL;
