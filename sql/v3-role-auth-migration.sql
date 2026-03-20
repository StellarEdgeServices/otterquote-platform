-- ============================================================
-- ClaimShield v3 Migration: Role-Based Authentication
-- Run this in the Supabase SQL Editor.
-- ============================================================

-- 1. Add role column to profiles table
-- Default is 'homeowner' since that's the majority of users.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'homeowner'
  CHECK (role IN ('homeowner', 'contractor'));

-- 2. Create an index on role for fast lookups (e.g., nav auth slot)
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles (role);

-- 3. If any existing contractors were inserted via contractor-join.html
--    and also have a row in the contractors table, backfill their role.
UPDATE profiles
SET role = 'contractor'
WHERE id IN (
  SELECT user_id FROM contractors WHERE user_id IS NOT NULL
)
AND role = 'homeowner';

-- 4. Add a comment for documentation
COMMENT ON COLUMN profiles.role IS 'User role: homeowner or contractor. Determines dashboard routing and nav behavior.';
