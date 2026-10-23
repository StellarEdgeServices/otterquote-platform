-- STATUS (gh-1438, as of 2026-10-23): NOT APPLIED
-- FILE ROLE: rollback file of set gh2875_contractor_sms_verify_rate_limits (forward and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-23 under #2875. Production read-only (Supabase MCP execute_sql, SELECT only) 2026-10-23: no
--   contractor-sms-verify-* row in public.rate_limit_config, 0 rate_limits rows for those names. No database was written to produce this file.
-- REPO COPY: none. When applied, file the forward under its real ledger version in supabase/migrations/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Reverts: supabase/migrations_drafts/gh2875_contractor_sms_verify_rate_limits.sql
-- Effect: removes the two config rows, which puts contractor-sms-verify back to fail-closed: check_rate_limit() denies every call
--   and the function answers 429 rate_limited to everyone. That is the safe direction (no code is texted), so this rollback needs no
--   function change. It also deletes the rows if someone tuned them by hand after the apply; record their values first if so.
-- Leaves public.rate_limits history rows in place (they are the call log, harmless without a config row) and touches no other function's row.
-- Idempotent: a second run deletes nothing.

BEGIN;

DELETE FROM public.rate_limit_config
 WHERE function_name IN ('contractor-sms-verify-start', 'contractor-sms-verify-check');

COMMIT;
