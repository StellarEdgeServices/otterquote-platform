-- STATUS (gh-1438, as of 2026-10-13T20:39:04Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2491_claims_platform_fee_charged_guard (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: written by gh-2491 (PR for the platform_fee_charged guard); the forward file creates exactly the two objects dropped here and changes nothing else
-- REPO COPY: none in supabase/migrations/ (this is a manual reference rollback)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2491 ROLLBACK for supabase/migrations_drafts/gh2491_claims_platform_fee_charged_guard.sql
--
-- Manual reference only. Never rename this into a 14-digit timestamp or move it into
-- supabase/migrations/ -- the CLI would replay it FORWARD and undo the guard it exists to revert.
-- Drops the trigger and its function. Rolling back re-opens the browser write of claims.platform_fee_charged:
-- if gh2491_message_counterpart.sql has been applied by then, roll that back first or accept that a claim owner
-- can release their own name to their selected contractor. No data is touched. If the forward file was applied
-- through the ledger, also delete its supabase_migrations.schema_migrations row.

BEGIN;

DROP TRIGGER IF EXISTS claims_guard_platform_fee_charged ON public.claims;
DROP FUNCTION IF EXISTS public.claims_guard_platform_fee_charged();

COMMIT;
