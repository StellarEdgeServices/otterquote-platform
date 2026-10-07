-- STATUS (gh-1438, as of 2026-10-06T20:16:10Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2559_bidder_claims_view (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: the forward file has not been applied (no ledger row; no view named bidder_claim_summary, pg_class read 2026-10-06). This rollback was run inside the same rolled-back proof block as the forward file (supabase/tests/gh2559_bidder_claims_view_proof.sql).
-- REPO COPY: none. When the forward file is applied, move this file to supabase/migrations_rollbacks/ under the forward file's ledger version.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback for gh2559_bidder_claims_view.sql. Drops the view. Nothing else was changed by the forward file.
-- ORDER: if gh2559_claims_policy_narrow.sql has been applied, roll THAT back first (its rollback file),
-- otherwise bidders lose the only way to read a claim. If the published pages already read the view, roll
-- the pages back too (re-deploy the previous Netlify deploy), or they show empty opportunity lists.
-- If the forward file was applied with a ledger row, also delete that supabase_migrations.schema_migrations row.
BEGIN;

SET LOCAL lock_timeout = '5s';

DROP VIEW IF EXISTS public.bidder_claim_summary;

COMMIT;
