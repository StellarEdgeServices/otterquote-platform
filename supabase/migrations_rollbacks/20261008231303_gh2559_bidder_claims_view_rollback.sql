-- STATUS (gh-1438): the forward file is APPLIED (ledger version 20261008231303, name gh2559_bidder_claims_view; evidence #2559 comment 6070932320); this rollback has not been run.
-- FILE ROLE: rollback file of set gh2559_bidder_claims_view (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: before the apply (no ledger row yet; no view named bidder_claim_summary, pg_class read 2026-10-06). This rollback was run inside the same rolled-back proof block as the forward file (supabase/tests/gh2559_bidder_claims_view_proof.sql).
-- REPO COPY: this file, moved from supabase/migrations_drafts/ after the apply; the forward file is supabase/migrations/20261008231303_gh2559_bidder_claims_view.sql.
-- Never move into supabase/migrations/ (the CLI would replay it forward). Rollback only on a human decision, after saying so on #2559.
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
