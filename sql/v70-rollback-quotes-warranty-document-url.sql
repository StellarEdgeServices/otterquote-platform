-- Rollback for v70: Warranty Upload
-- Removes warranty_document_url and warranty_uploaded_at from quotes.
-- Run this script only if the v70 migration needs to be reversed.
-- WARNING: This permanently drops any uploaded warranty URLs already stored.

ALTER TABLE quotes
  DROP COLUMN IF EXISTS warranty_document_url,
  DROP COLUMN IF EXISTS warranty_uploaded_at;
