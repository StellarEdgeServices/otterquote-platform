-- Migration v61: Add is_test flag to profiles for E2E test account isolation
-- Applied: 2026-04-28
-- Author: Ram (automated flow-test suite build, D-196 followup)
--
-- Adds a flag to mark test accounts created by the automated flow-test suite.
-- Test accounts are excluded from production analytics, dunning, and reporting.
-- The column is set to TRUE by seed/seed.mjs; all existing rows default to FALSE.
-- Companion rollback: sql/v61-test-accounts-rollback.sql

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN DEFAULT false NOT NULL;

COMMENT ON COLUMN profiles.is_test IS
  'TRUE for test accounts created by the automated E2E flow-test suite '
  '(tests/e2e/seed/seed.mjs). Exclude these rows from analytics, dunning, '
  'and contractor-network reporting. Set by seed script only — never edit manually.';

-- Sparse index: fast exclusion in analytics queries (WHERE is_test = false)
-- and fast lookup of all test accounts for teardown.
CREATE INDEX IF NOT EXISTS idx_profiles_is_test
  ON profiles (is_test)
  WHERE is_test = true;
