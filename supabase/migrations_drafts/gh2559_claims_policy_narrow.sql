-- STATUS (gh-1438, as of 2026-10-06T20:16:10Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2559_claims_policy_narrow, step 3 of 3 (see the apply order in supabase/migrations/20261008231303_gh2559_bidder_claims_view.sql, now filed and applied; the STATUS is the set's)
-- EVIDENCE: written 2026-10-06T20:16:10Z; proved forward and rollback on production inside one rolled-back block (supabase/tests/gh2559_bidder_claims_view_proof.sql). pg_policy read the same day: public.claims carries the 8 policies named in the pre-flight, including the two contractor SELECT policies this file replaces. No ledger row exists for this set.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2559_claims_policy_narrow
-- GitHub: #2559 (claims-row half). Decision: D-368.
-- Tier: 3B. It removes read access from every contractor who is not the one the homeowner selected. It waits
--   for its 24-hour notice (R-097) on #2559, and is applied only after (1) gh2559_bidder_claims_view.sql is live (APPLIED 2026-10-08, supabase/migrations/20261008231303_gh2559_bidder_claims_view.sql)
--   and (2) the page change that reads the view is PUBLISHED. Never applied from this directory.
-- Rollback: supabase/migrations_drafts/gh2559_claims_policy_narrow_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2559_bidder_claims_view_pre-flight.md
-- Proof: supabase/tests/gh2559_bidder_claims_view_proof.sql
--
-- What changes on public.claims (SELECT only; INSERT, UPDATE, DELETE policies are not touched):
--   DROP   "Contractors can view biddable claims"          (every active contractor read every column of every
--                                                           claim open for bids)
--   DROP   "Contractors can view claims for their quotes"  (every contractor who had put in a bid kept reading
--                                                           the whole row, selected or not, open or closed)
--   CREATE "Contractors can view claims they are selected on": a contractor reads the base row of a claim only
--                                                           when claims.selected_contractor_id is the contractor's own.
-- What does not change: the owner's policy ("Users can view own claims"), the admin policy (claims_admin_select),
--   service_role (bypasses), the write policies, every other table. The selected contractor reads the base row
--   exactly as today (the storage policy for the selected contractor joins claims under the caller's row
--   security and keeps working because that row stays visible to the selected contractor).
-- The new policy is a plain subquery on contractors, the same shape the dropped biddable policy used; it adds
-- no function and no grant.
BEGIN;

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS "Contractors can view biddable claims" ON public.claims;
DROP POLICY IF EXISTS "Contractors can view claims for their quotes" ON public.claims;
DROP POLICY IF EXISTS "Contractors can view claims they are selected on" ON public.claims;

CREATE POLICY "Contractors can view claims they are selected on"
ON public.claims FOR SELECT
TO authenticated
USING (
  selected_contractor_id IN (
    SELECT ct.id FROM public.contractors ct WHERE ct.user_id = (SELECT auth.uid())
  )
);

-- Refuse to finish if the view this narrowing depends on is not there.
DO $assert$
BEGIN
  IF to_regclass('public.bidder_claim_summary') IS NULL THEN
    RAISE EXCEPTION 'gh2559: public.bidder_claim_summary does not exist; apply gh2559_bidder_claims_view.sql first' USING ERRCODE = 'P0A03';
  END IF;
END
$assert$;

COMMIT;
