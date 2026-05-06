-- v62 rollback: removes D-214/D-215 schema additions
-- Run this if v62 migration needs to be reversed
ALTER TABLE quotes
  DROP COLUMN IF EXISTS platform_fee_pct,
  DROP COLUMN IF EXISTS platform_fee_basis,
  DROP COLUMN IF EXISTS fee_accepted_at;

DROP TABLE IF EXISTS platform_fee_config;
DROP TABLE IF EXISTS fee_acceptances;
