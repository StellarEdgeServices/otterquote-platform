-- Rollback v71 — drops the partial index added in v71.
DROP INDEX IF EXISTS idx_quotes_warranty_uploaded_at;
