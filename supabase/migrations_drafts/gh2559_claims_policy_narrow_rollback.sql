-- STATUS (gh-1438, as of 2026-10-06T20:16:10Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2559_claims_policy_narrow (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: the forward file has not been applied (no ledger row; the two contractor SELECT policies below are live, pg_policy read 2026-10-06). This rollback was run inside the same rolled-back proof block as the forward file (supabase/tests/gh2559_bidder_claims_view_proof.sql).
-- REPO COPY: none. When the forward file is applied, move this file to supabase/migrations_rollbacks/ under the forward file's ledger version.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback for gh2559_claims_policy_narrow.sql.
-- WARNING: this RE-OPENS what D-368 closed: every active contractor can again read all 130 columns of every
-- claim open for bids, and every contractor with a bid on a claim reads its whole row. Run it only if the
-- narrowing refuses a read a contractor needs, and say so on #2559.
-- It restores the two policies exactly as they were live on 2026-10-06 (text read from pg_policy) and drops
-- the replacement. It does not touch the view (supabase/migrations_rollbacks/20261008231303_gh2559_bidder_claims_view_rollback.sql does that).
BEGIN;

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS "Contractors can view claims they are selected on" ON public.claims;
DROP POLICY IF EXISTS "Contractors can view biddable claims" ON public.claims;
DROP POLICY IF EXISTS "Contractors can view claims for their quotes" ON public.claims;

CREATE POLICY "Contractors can view biddable claims"
ON public.claims FOR SELECT
USING (
  (ready_for_bids = true)
  AND (status = ANY (ARRAY['active'::text, 'bidding'::text, 'pending'::text]))
  AND ((SELECT auth.uid()) IN (SELECT contractors.user_id FROM public.contractors WHERE contractors.status = 'active'::text))
  AND ((is_test = false) OR ((is_test = true) AND ((SELECT auth.uid()) IN (
        SELECT contractors.user_id FROM public.contractors
         WHERE contractors.status = 'active'::text AND contractors.is_test = true))))
);

CREATE POLICY "Contractors can view claims for their quotes"
ON public.claims FOR SELECT
TO authenticated
USING (
  id IN (SELECT public.get_contractor_quote_claim_ids((SELECT auth.uid())))
);

COMMIT;
