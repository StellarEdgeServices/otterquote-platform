-- Migration: v61_d210_contractor_pre_approval_doc_gate
-- Filed by: gh-1438 migration history backfill batch 2 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 2, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-06T03:21:40Z, recorded in
-- supabase_migrations.schema_migrations as version 20260506032140, name
-- "v61_d210_contractor_pre_approval_doc_gate". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 2. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v61: D-210 contractor pre-approval document gate columns
-- Decision: D-210 (May 4, 2026), amended by D-213 (May 5, 2026)
-- Companion rollback: sql/v61-rollback.sql

-- WCE-1 Workers' Compensation Clearance Certificate columns (D-213)
-- IC 22-3-2-14.5 state-issued certificate; follows same pattern as CGL COI
ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS wc_cert_file_ref        TEXT,
  ADD COLUMN IF NOT EXISTS wc_cert_expiry          DATE,
  ADD COLUMN IF NOT EXISTS wc_cert_uploaded_at     TIMESTAMPTZ;

-- Contractor license document columns (D-210)
-- license_path: storage bucket path; license_document_url: display URL
-- license_attestation_signed_at: when no-license attestation was signed (nolicense-v1-2026-05)
ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS license_path                  TEXT,
  ADD COLUMN IF NOT EXISTS license_document_url          TEXT,
  ADD COLUMN IF NOT EXISTS license_attestation_signed_at TIMESTAMPTZ;

-- Legacy flag: TRUE for contractors approved before D-210 gate was enforced
-- Grandfathered contractors bypass the three-artifact gate until manually migrated
ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS legacy_pre_approval BOOLEAN NOT NULL DEFAULT FALSE;

-- Flag all currently-approved contractors as legacy (avoid mid-migration lockout per D-210)
UPDATE contractors
  SET legacy_pre_approval = TRUE
  WHERE approved_at IS NOT NULL;

-- Helper function: returns whether contractor has all three D-210 artifacts on file
-- Used by admin-contractors.html approval gate; future bid_can_submit expansion (86e17m7pq)
-- legacy_pre_approval = TRUE bypasses gate (grandfathered contractor)
CREATE OR REPLACE FUNCTION contractor_has_required_docs(p_contractor_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_has_cgl     BOOLEAN;
  v_has_wc      BOOLEAN;
  v_has_license BOOLEAN;
  v_legacy      BOOLEAN;
BEGIN
  SELECT
    -- CGL COI: file present and not expired (D-170)
    (coi_file_url IS NOT NULL AND (coi_expires_at IS NULL OR coi_expires_at >= CURRENT_DATE)),
    -- W/C: either policy on file (carrier + policy# + not expired)
    --      OR WCE-1 certificate uploaded and not expired (D-213)
    (
      (wc_carrier IS NOT NULL AND wc_policy_number IS NOT NULL
        AND (wc_expiration_date IS NULL OR wc_expiration_date >= CURRENT_DATE))
      OR
      (wc_cert_file_ref IS NOT NULL
        AND (wc_cert_expiry IS NULL OR wc_cert_expiry >= CURRENT_DATE))
    ),
    -- License: license document on file OR no-license attestation signed (D-210)
    (
      license_document_url IS NOT NULL
      OR license_attestation_signed_at IS NOT NULL
    ),
    legacy_pre_approval
  INTO v_has_cgl, v_has_wc, v_has_license, v_legacy
  FROM contractors
  WHERE id = p_contractor_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Legacy contractors bypass gate until manually migrated
  IF COALESCE(v_legacy, FALSE) THEN
    RETURN TRUE;
  END IF;

  RETURN COALESCE(v_has_cgl, FALSE)
     AND COALESCE(v_has_wc, FALSE)
     AND COALESCE(v_has_license, FALSE);
END;
$$;
