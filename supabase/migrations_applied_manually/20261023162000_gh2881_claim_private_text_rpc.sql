-- >>> APPLIED MANUALLY, NO LEDGER ROW (gh-1438, filed 2026-10-23T16:44:20Z) <<<
-- Applied to production (yeszghaspzwwstvsrioa) on 2026-10-23 at about 16:20Z (filename seconds are 00: the minute is from the apply record, the second is not recorded), via the Supabase Management API,
-- not via the migration ledger. Record: step 1 applied at about 16:20Z via the Management API (HTTP 201), file sha256 c45fd3ec... = the draft on main; NO schema_migrations row.
-- sha256 of the applied file = sha256 of everything BELOW the next line (the draft as it stood at apply, STATUS header included): c45fd3ecdb8a0c7cfe7eb2773f90936db9907da3f43d5674b28ec7d5bc66d72d
-- The STATUS line below is the draft-time header and is SUPERSEDED by this block. Never move this file into supabase/migrations/ and never give it a
-- schema_migrations row on that basis alone (see supabase/migrations/README.md, migrations_applied_manually). Not run by any automation.
-- ---- BEGIN APPLIED BYTES ----
-- STATUS (gh-1438, as of 2026-10-19T19:10:11Z): NOT APPLIED
-- FILE ROLE: step 1 of 3 of set gh2881_claims_private_text_column_grants: ADDITIVE owner/admin read path (apply FIRST, before the pages are published)
-- EVIDENCE: drafted 2026-10-19T19:10:11Z under #2881 (CTO RUN 72 worker cto72-b2881). No ledger row exists. Production was not touched by this draft; the proof ran on a throwaway Postgres only (supabase/tests/gh2881_claims_private_text_proof_run.sh).
-- REPO COPY: none. When applied, file the forward under its real ledger version in supabase/migrations/ and the rollback and pre-flight in supabase/migrations_rollbacks/.
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
