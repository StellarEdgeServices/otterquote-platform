-- STATUS (gh-1438, as of 2026-10-21): NOT APPLIED
-- FILE ROLE: forward file of set gh2105_color_contractor_rpc (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-10-21 under #2105 (CTO RUN 76, checklist item C, comment 6305573044; Dustin's answer on #2974, comment 6323378714). No database was read or written to produce this file; the production facts it relies on (homeowners have no SELECT on public.contractors; contractors.company_name text NOT NULL and contractors.preferred_brands text[] exist; claims.user_id and claims.selected_contractor_id exist) are those recorded in comment 6305573044 and supabase/migrations/20260101000000_v000_baseline_schema.sql, and are to be re-measured in the pre-flight before apply.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2105_color_contractor_rpc
-- GitHub: #2105 (checklist C), #2974. Tier: 3B (new SECURITY DEFINER function reachable by authenticated users). R-097 24-hour notice before apply.
-- Rollback: supabase/migrations_drafts/gh2105_color_contractor_rpc_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2105_color_contractor_rpc_pre-flight.md
--
-- What changes: adds public.get_claim_color_contractor(p_claim_id uuid), returning ONLY company_name and preferred_brands of the
-- contractor selected on a claim the caller owns. The homeowner colour-selection page (color-selection.html and the React
-- color-selection route) reads those two values to name the contractor and pick the shingle brand; homeowners have no SELECT on
-- public.contractors, so the embedded join the page used returned an error and the page never loaded. No policy is added to
-- public.contractors (it would expose phone, email and Stripe fields). Nothing else changes: no table, column, policy or grant on an
-- existing object.
--
-- Ownership: the WHERE clause ties the row to auth.uid() through claims.user_id, so a caller who does not own the claim, an
-- unauthenticated caller (auth.uid() is NULL, NULL = NULL is not true) and a claim with no selected contractor all get zero rows.
-- Execute is revoked from PUBLIC and anon and granted to authenticated only.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_claim_color_contractor(p_claim_id uuid)
RETURNS TABLE(company_name text, preferred_brands text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT ct.company_name, ct.preferred_brands
    FROM public.claims cl
    JOIN public.contractors ct ON ct.id = cl.selected_contractor_id
   WHERE cl.id = p_claim_id
     AND cl.user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.get_claim_color_contractor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_claim_color_contractor(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_claim_color_contractor(uuid) TO authenticated;

COMMIT;
