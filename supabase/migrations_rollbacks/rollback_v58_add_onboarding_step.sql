-- Rollback v58: Remove onboarding_step column from contractors table
ALTER TABLE contractors DROP COLUMN IF EXISTS onboarding_step;
