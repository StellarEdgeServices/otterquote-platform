-- STATUS (gh-1438, as of 2026-10-21): NOT APPLIED
-- FILE ROLE: rollback file of set gh2105_color_contractor_rpc (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-10-21 under #2105 (CTO RUN 76, checklist item C, comment 6305573044; Dustin's answer on #2974, comment 6323378714). No database was read or written to produce this file; the production facts it relies on (homeowners have no SELECT on public.contractors; contractors.company_name text NOT NULL and contractors.preferred_brands text[] exist; claims.user_id and claims.selected_contractor_id exist) are those recorded in comment 6305573044 and supabase/migrations/20260101000000_v000_baseline_schema.sql, and are to be re-measured in the pre-flight before apply.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: gh2105_color_contractor_rpc_rollback.sql
-- Reverts: gh2105_color_contractor_rpc.sql
-- GitHub: #2105
--
-- Drops the function. Safe at any time: nothing in the database depends on it; the only callers are the two colour-selection
-- pages, which treat an RPC error as "contractor unknown" (generic contractor name, brand unconfirmed) and still load.
BEGIN;

DROP FUNCTION IF EXISTS public.get_claim_color_contractor(uuid);

COMMIT;
