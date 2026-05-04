-- Migration v71 — Index on quotes.warranty_uploaded_at (partial)
-- Reserved Apr 29, 2026 by Session ~483 review-URL investigation; consumed May 1, 2026
-- by CTO Wave 3 autonomous sweep for ClickUp task 86e16dwez.
--
-- Rationale: homeowner dashboard "📄 View Warranty" filtering and contractor
-- "completed-with-warranty" listing both filter on warranty_uploaded_at IS NOT NULL.
-- Partial index (WHERE warranty_uploaded_at IS NOT NULL) keeps index size small
-- since warranty uploads are sparse early in platform lifetime.
--
-- We are NOT indexing warranty_document_url separately — it is a TEXT column, and
-- callers always lookup by quote_id (PK) and inspect the URL field; no value in a
-- standalone index there. If usage patterns shift, revisit.
--
-- D-182 classification: Tier 3 deploy. Companion rollback at v71-rollback-*.sql.

CREATE INDEX IF NOT EXISTS idx_quotes_warranty_uploaded_at
  ON quotes (warranty_uploaded_at)
  WHERE warranty_uploaded_at IS NOT NULL;

COMMENT ON INDEX idx_quotes_warranty_uploaded_at IS
  'Partial index for warranty-completed quote lookups (homeowner dashboard, contractor history). Added v71, ClickUp 86e16dwez.';
