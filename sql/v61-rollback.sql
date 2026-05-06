-- v61 rollback: removes D-210/D-213 columns and helper function
-- Run this if v61 migration needs to be reversed
DROP FUNCTION IF EXISTS contractor_has_required_docs(UUID);
ALTER TABLE contractors
  DROP COLUMN IF EXISTS wc_cert_file_ref,
  DROP COLUMN IF EXISTS wc_cert_expiry,
  DROP COLUMN IF EXISTS wc_cert_uploaded_at,
  DROP COLUMN IF EXISTS license_path,
  DROP COLUMN IF EXISTS license_document_url,
  DROP COLUMN IF EXISTS license_attestation_signed_at,
  DROP COLUMN IF EXISTS legacy_pre_approval;
