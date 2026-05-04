-- W3-P4: Warranty Upload — v70
-- Adds warranty_document_url and warranty_uploaded_at to the quotes table.
-- Contractor uploads their executed warranty PDF after job completion;
-- URL is stored here so homeowners can retrieve it years later.
--
-- Migration: v70
-- Rollback:  sql/v70-rollback-quotes-warranty-document-url.sql
-- ClickUp:   86e0yvj7w

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS warranty_document_url TEXT        NULL,
  ADD COLUMN IF NOT EXISTS warranty_uploaded_at  TIMESTAMPTZ NULL;

COMMENT ON COLUMN quotes.warranty_document_url IS
  'Storage path in contractor-documents bucket for the warranty PDF. '
  'Format: contractor-documents/warranties/{quote_id}/{timestamp}-{filename}.pdf. '
  'NULL until contractor uploads. Replacement updates in place; full history in activity_log.';

COMMENT ON COLUMN quotes.warranty_uploaded_at IS
  'Timestamp of the most recent warranty upload. Replacement updates this in place.';
