-- STATUS (gh-1438, as of 2026-10-23T16:44:20Z): APPLIED
-- FILE ROLE: step 1 of 3 of set gh2881_claims_private_text_column_grants: ADDITIVE owner/admin read path (apply FIRST, before the pages are published)
-- EVIDENCE: APPLIED -- #2881 comment 6369520677 (CTO RUN 77): step 1 applied at about 16:20Z via the Management API (HTTP 201), file sha256 c45fd3ec... = the draft on main; NO schema_migrations row. Earlier draft-time evidence, kept: drafted 2026-10-19T19:10:11Z under #2881 (CTO RUN 72 worker cto72-b2881). No ledger row exists. Production was not touched by this draft; the proof ran on a throwaway Postgres only (supabase/tests/gh2881_claims_private_text_proof_run.sh).
-- REPO COPY: supabase/migrations_applied_manually/20261023162000_gh2881_claim_private_text_rpc.sql (forward, applied outside the ledger), supabase/migrations_rollbacks/20261023162000_gh2881_claim_private_text_rpc_rollback.sql (rollback)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2881_claim_private_text_rpc
-- GitHub: #2881. Tier: ADDITIVE (creates one function; no existing object or privilege changes). Safe to apply before the pages that call it.
-- Why it is its own file: the pages call this function and fall back safely if it is missing, but a page that cannot read her notes must never
-- save a blank over them, so the function goes live BEFORE the pages, and the column revoke (step 3) goes live AFTER them.
-- Apply order: 1. this file  2. publish the pages (static + react-app)  3. gh2881_claims_private_text_column_grants.sql (gated, Tier 3B).
-- Rollback: gh2881_claim_private_text_rpc_rollback.sql (only after step 3 is rolled back).
BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regprocedure('public.is_admin_email()') IS NULL THEN
    RAISE EXCEPTION 'gh2881: public.is_admin_email() does not exist' USING ERRCODE = 'P0A82';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.claim_private_text(p_claim_id uuid)
RETURNS TABLE (homeowner_notes text, urgency_reason text, project_confirmation jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT c.homeowner_notes, c.urgency_reason, c.project_confirmation
    FROM public.claims c
   WHERE c.id = p_claim_id
     AND (c.user_id = (SELECT auth.uid()) OR public.is_admin_email());
$fn$;

COMMENT ON FUNCTION public.claim_private_text(uuid) IS
  'gh-2881 / D-390: the claim owner''s (or an admin''s) read of the three homeowner-typed columns that authenticated can no longer SELECT on public.claims. One row or none.';

REVOKE ALL ON FUNCTION public.claim_private_text(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_private_text(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_private_text(uuid) TO authenticated;

COMMIT;
