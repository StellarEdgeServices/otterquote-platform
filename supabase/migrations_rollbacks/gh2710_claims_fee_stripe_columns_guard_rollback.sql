-- STATUS (gh-1438, as of 2026-10-14T06:58:34Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2710_claims_fee_stripe_columns_guard (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: written by gh-2710; the forward file creates exactly the two objects dropped here and changes nothing else
-- REPO COPY: none in supabase/migrations/ (this is a manual reference rollback)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2710 ROLLBACK for supabase/migrations_drafts/gh2710_claims_fee_stripe_columns_guard.sql
--
-- Manual reference only. Never rename this into a 14-digit timestamp or move it into
-- supabase/migrations/ -- the CLI would replay it FORWARD and undo the guard it exists to revert.
-- Drops the trigger and its function only. It touches none of the gh2491, gh2519, gh2564 or gh2626 objects, so it is
-- safe in any order relative to their rollbacks. Rolling back re-opens the browser write of claims.platform_fee_stripe_id
-- and claims.platform_fee_amount. No data is touched. If the forward file was applied through the ledger, also delete
-- its supabase_migrations.schema_migrations row.

BEGIN;

DROP TRIGGER IF EXISTS claims_guard_fee_stripe_columns ON public.claims;
DROP FUNCTION IF EXISTS public.claims_guard_fee_stripe_columns();

COMMIT;
