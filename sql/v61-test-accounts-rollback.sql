-- ROLLBACK for v61: Remove is_test flag from profiles
-- Use only if v61 needs to be reversed.
--
-- WARNING: Any test accounts will lose their is_test marker after this rollback.
-- Recommend manually deleting test auth users from auth.users before rolling back
-- if you want a clean slate. Test account emails:
--   test-homeowner@otterquote-internal.test
--   test-contractor@otterquote-internal.test

DROP INDEX IF EXISTS idx_profiles_is_test;

ALTER TABLE profiles
  DROP COLUMN IF EXISTS is_test;
