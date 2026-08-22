-- Rollback: v113_derived_role_view_rollback.sql
-- Reverts: v113_derived_role_view.sql
-- Author: Claude Code (automated, run-work rw-909-f22-b4vw)
-- Date: 2026-08-19
-- WARNING: This view is read-only and additive -- no data was written or
--          removed by the forward migration, so this rollback is a pure
--          schema revert with zero data-loss risk. Safe to run at any time.
--          If any deployed code has already been cut over to read this
--          view (js/auth.js getRole(), auth-provider.tsx resolveRole(),
--          auth-callback/page.tsx), that code must be rolled back FIRST or
--          it will start erroring on a missing relation -- see gh-909 call
--          site PR, which is deliberately blocked from merging ahead of
--          this migration for exactly this reason (and by extension, ahead
--          of any rollback of it too).

BEGIN;

DROP VIEW IF EXISTS public.resolved_user_role;

COMMIT;
