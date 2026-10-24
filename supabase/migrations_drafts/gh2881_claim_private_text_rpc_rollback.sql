-- STATUS (gh-1438, as of 2026-10-19T19:10:11Z): NOT APPLIED
-- FILE ROLE: rollback of step 1 (drops the owner RPC); run only after the column-grant rollback AND after the pages stop calling it
-- EVIDENCE: drafted 2026-10-19T19:10:11Z under #2881 (CTO RUN 72 worker cto72-b2881). No ledger row exists. Production was not touched by this draft; the proof ran on a throwaway Postgres only (supabase/tests/gh2881_claims_private_text_proof_run.sh).
-- REPO COPY: none. When applied, file the forward under its real ledger version in supabase/migrations/ and the rollback and pre-flight in supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
BEGIN;
DROP FUNCTION IF EXISTS public.claim_private_text(uuid);
COMMIT;
