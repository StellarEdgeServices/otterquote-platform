-- STATUS (gh-1438, as of 2026-10-23T16:44:20Z): APPLIED (forward); this rollback is NOT run
-- FILE ROLE: rollback of step 1 (drops the owner RPC); run only after the column-grant rollback AND after the pages stop calling it
-- EVIDENCE: APPLIED -- #2881 comment 6369520677 (CTO RUN 77): step 1 applied at about 16:20Z via the Management API (HTTP 201), file sha256 c45fd3ec... = the draft on main; NO schema_migrations row. Earlier draft-time evidence, kept: drafted 2026-10-19T19:10:11Z under #2881 (CTO RUN 72 worker cto72-b2881). No ledger row exists. Production was not touched by this draft; the proof ran on a throwaway Postgres only (supabase/tests/gh2881_claims_private_text_proof_run.sh).
-- REPO COPY: supabase/migrations_applied_manually/20261023162000_gh2881_claim_private_text_rpc.sql (forward, applied outside the ledger), supabase/migrations_rollbacks/20261023162000_gh2881_claim_private_text_rpc_rollback.sql (rollback)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
BEGIN;
DROP FUNCTION IF EXISTS public.claim_private_text(uuid);
COMMIT;
