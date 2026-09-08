-- Rollback: 20260819224323_v113b_resolved_user_role_grant_hardening_rollback.sql
-- Reverts: 20260819224323_v113b_resolved_user_role_grant_hardening.sql
-- Author: Claude Code (automated, run-work rw-909-f22-b4vw)
-- Date: 2026-08-19
--
-- WARNING: Restores the pre-v113b grants v113 itself left in place (the
--          direct default-ACL grant to authenticated). Since v113's own
--          rollback drops the view entirely, running this rollback only
--          matters if v113b is being reverted WITHOUT also reverting v113 --
--          an unusual, narrow case. Not expected to be needed in practice.

BEGIN;

REVOKE ALL ON public.resolved_user_role FROM authenticated;
GRANT ALL ON public.resolved_user_role TO authenticated;

COMMIT;
