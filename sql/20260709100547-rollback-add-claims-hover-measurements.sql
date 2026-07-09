-- Rollback: remove claims.hover_measurements (JSONB)
-- Reverses migration_add_claims_hover_measurements.sql.
--
-- WARNING: dropping this column permanently discards any parsed Hover
-- measurements stored on existing claims. The data can be re-derived by
-- re-running parse-hover-measurements against claims.measurements_filename.
--
-- Idempotent: safe to re-run.

ALTER TABLE claims DROP COLUMN IF EXISTS hover_measurements;
