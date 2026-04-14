-- v34 — Fix contractors.status check constraint (D-118 correction)
-- Problem: v28's DO $$ block used pg_constraints (nonexistent) instead of pg_constraint,
--          so the IF NOT EXISTS guard silently failed and the old constraint (which allows
--          'active', 'inactive', 'suspended', 'pending') was never replaced.
--          The column DEFAULT was correctly set to 'pending_approval' by v28, but the
--          constraint still rejects that value — causing every new contractor signup to fail
--          with a check-constraint violation.
-- Fix: Drop the old constraint and add the correct one per D-118.
-- Safe: Only existing contractor has status='active', which remains valid.
-- Apply via Supabase Management API or SQL Editor.

-- 1. Drop the stale constraint
ALTER TABLE contractors DROP CONSTRAINT IF EXISTS contractors_status_check;

-- 2. Add the correct constraint (matches D-118 and all code references)
ALTER TABLE contractors
  ADD CONSTRAINT contractors_status_check
  CHECK (status IN ('pending_approval', 'active', 'suspended', 'inactive'));

-- 3. Confirm default is still 'pending_approval' (set by v28, should already be correct)
ALTER TABLE contractors ALTER COLUMN status SET DEFAULT 'pending_approval';
