-- Rollback: 20260819224500_gh909_v113b_resolved_user_role_grant_hardening
-- Reverts: 20260819224500_gh909_v113b_resolved_user_role_grant_hardening.sql
-- WARNING: This restores the default-privilege over-grant on
-- resolved_user_role (authenticated gains INSERT/UPDATE/DELETE/TRUNCATE/
-- REFERENCES/TRIGGER it does not need, on a view that's read-only by
-- design). Should not be run except to diagnose an unforeseen regression.

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.resolved_user_role TO authenticated;
