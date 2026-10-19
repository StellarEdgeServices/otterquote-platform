-- STATUS (gh-1438, as of 2026-10-19): NOT APPLIED
-- FILE ROLE: rollback file of set gh2559_claims_bid_open_guard (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: forward file not applied; see gh2559_claims_bid_open_guard.sql
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback for gh2559_claims_bid_open_guard. Run by hand, only after the forward file was applied.
-- WARNING: this RE-OPENS both gaps: a claim can again open for bids on an unread estimate, a summary that repeats the homeowner's
-- identity can again reach a bidder, and a replaced estimate keeps the old parse. The forward file changed no data and no existing function or trigger, so nothing else needs restoring.
-- If the migration was applied, also delete its supabase_migrations.schema_migrations row.
BEGIN;

DROP TRIGGER IF EXISTS claims_guard_bid_open ON public.claims;
DROP TRIGGER IF EXISTS claims_guard_a0_parse_state ON public.claims;
DROP FUNCTION IF EXISTS public.claims_estimate_parse_state_guard();
DROP FUNCTION IF EXISTS public.claims_guard_bid_open();
DROP FUNCTION IF EXISTS public.gh2559_summary_identity_hit(jsonb, text, text[], text, text);
DROP FUNCTION IF EXISTS public.gh2559_estimate_is_read(jsonb, timestamptz);

-- Removes the additive column (and its CHECK). Any 'unsupported' / 'parsed' marks written since the apply are lost; they are
-- re-derivable by re-running parse-loss-sheet with the service role. parse-loss-sheet writes this column, so redeploy the pre-gh2559
-- version of that function BEFORE running this file, or its parse writes fail.
ALTER TABLE public.claims DROP COLUMN IF EXISTS loss_sheet_parse_status;

COMMIT;
