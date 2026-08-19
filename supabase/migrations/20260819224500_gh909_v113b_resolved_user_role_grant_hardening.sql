-- Migration: gh909_v113b_resolved_user_role_grant_hardening
-- Author: Claude Code (automated, run-work rw-909-f22-apply2)
-- Date: 2026-08-19
-- GitHub: #909 (v113 follow-up)
--
-- Summary: v113_derived_role_view.sql created public.resolved_user_role with
-- an explicit `GRANT SELECT ON public.resolved_user_role TO authenticated`
-- and `REVOKE ALL ... FROM PUBLIC/anon`, but Postgres' default privileges
-- on a newly created relation ALSO grant the full privilege set (SELECT/
-- INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) to whichever role owns
-- the CREATE, which on this project resolves through to `authenticated`
-- picking up more than the intended SELECT-only grant. Same class of trap
-- already documented for functions (v95a referral-RPC grant hardening,
-- "Supabase function grant defaults" memory) -- here it hit a view instead
-- of a function.
--
-- Applied directly against production immediately after v113 (same
-- session, 2026-08-19T22:4xZ) once the excess grant was found during
-- post-apply access-control verification. This migration is a repo-tracking
-- record of that already-applied fix, not a new change.
--
-- What changed: re-issued the REVOKE/GRANT pair explicitly and verified via
-- live aclexplode()/information_schema.table_privileges that authenticated
-- carries SELECT only and anon carries nothing.
--
-- Rollback: re-grant the full privilege set (restores the over-permissive
-- state) -- included per this repo's rollback-required convention, not
-- because reverting is ever the intended outcome.

REVOKE ALL ON public.resolved_user_role FROM PUBLIC;
REVOKE ALL ON public.resolved_user_role FROM anon;
REVOKE ALL ON public.resolved_user_role FROM authenticated;
GRANT SELECT ON public.resolved_user_role TO authenticated;
