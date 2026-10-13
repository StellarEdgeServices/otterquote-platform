-- STATUS (gh-1438, as of 2026-10-13T20:39:04Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2626_claims_award_columns_guard (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: written by gh-2626; the forward file creates exactly the two objects dropped here and changes nothing else
-- REPO COPY: none in supabase/migrations/ (this is a manual reference rollback)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2626 ROLLBACK for supabase/migrations_drafts/gh2626_claims_award_columns_guard.sql
--
-- Manual reference only. Never rename this into a 14-digit timestamp or move it into
-- supabase/migrations/ -- the CLI would replay it FORWARD and undo the guard it exists to revert.
-- Drops the trigger and its function. Rolling back re-opens the direct write of claims.selected_contractor_id,
-- selected_bid_amount and status = 'awarded' for the claim owner. No data is touched. If the forward file was
-- applied through the ledger, also delete its supabase_migrations.schema_migrations row.

BEGIN;

DROP TRIGGER IF EXISTS claims_guard_award_columns ON public.claims;
DROP FUNCTION IF EXISTS public.claims_guard_award_columns();

COMMIT;
