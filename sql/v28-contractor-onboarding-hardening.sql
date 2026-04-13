-- v28 — Contractor Onboarding Hardening (D-118)
-- Adds contractor approval gate, click-wrap agreement tracking, and profile completeness guidance.
-- Apply via Supabase Management API or SQL Editor.

-- 1. Alter contractors.status to default to 'pending_approval'
ALTER TABLE contractors ALTER COLUMN status SET DEFAULT 'pending_approval';

-- 2. Add check constraint for valid status values (if not already present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraints
    WHERE tablename = 'contractors' AND constraintname = 'contractors_status_check'
  ) THEN
    ALTER TABLE contractors
    ADD CONSTRAINT contractors_status_check
    CHECK (status IN ('pending_approval', 'active', 'suspended', 'inactive'));
  END IF;
END $$;

-- 3. Add columns to track agreement acceptance
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contractors' AND column_name = 'agreement_accepted_at'
  ) THEN
    ALTER TABLE contractors ADD COLUMN agreement_accepted_at TIMESTAMPTZ DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contractors' AND column_name = 'agreement_version'
  ) THEN
    ALTER TABLE contractors ADD COLUMN agreement_version TEXT DEFAULT NULL;
  END IF;
END $$;

-- 4. Add index for efficient queries on agreement status
CREATE INDEX IF NOT EXISTS idx_contractors_agreement_accepted_at
  ON contractors(agreement_accepted_at)
  WHERE agreement_accepted_at IS NULL;

-- 5. Add index for efficient status-based filtering
CREATE INDEX IF NOT EXISTS idx_contractors_status
  ON contractors(status);
