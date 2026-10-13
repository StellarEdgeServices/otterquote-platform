-- STATUS (gh-1438, as of 2026-10-13T20:39:04Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2626_claims_award_columns_guard (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: production read-only 2026-10-13 (Supabase MCP, SELECT only, pg_trigger and pg_policy reads): public.claims carries 11 user triggers and none checks that a selected contractor has a quote; policy "Users can update own claims" (UPDATE, user_id = auth.uid()) has no column restriction; rolled-back proof in supabase/tests/gh2626_claims_award_columns_guard_proof.sql
-- REPO COPY: none in supabase/migrations/ yet
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2626 (SECURITY, MONEY PATH): a claim owner can award, or set the selected contractor, by a direct write.
-- Tier: 3B (new trigger on the award path of a money-path table). Protective only (R-134): it only removes
-- capability from the browser roles. NOT APPLIED by the authoring session or by CI. R-097 notice applies.
-- Rollback: supabase/migrations_rollbacks/gh2626_claims_award_columns_guard_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh2626_claims_award_columns_guard_pre-flight.md
-- Proof (throwaway Postgres, six passes): supabase/tests/gh2626_claims_award_columns_guard_proof.sql
--
-- ORDER. Independent of gh2620_claims_payment_guard_security_definer (PR #2623) in what it does, and either can
-- be applied first. They interact on one path: until #2623 is applied, a React-app award is refused by the
-- payment-method guard for every homeowner (gh-2620), so this guard changes nothing there; once #2623 is
-- applied, THIS guard is what stops an award to a contractor who never bid (review of #2623, finding M1).
-- Ben's condition D on #2623 (6066956273) asks for this follow-up before #2623 is applied; this is it.
--
-- Problem (#2626, observed on production in rolled-back transactions by two reviewers). The policy
-- "Users can update own claims" lets the claim owner UPDATE any column of their claim. The only guards on the
-- award columns are claims_payment_method_guard (checks the contractor's payment method, never that the
-- contractor bid) and claims_guard_referral_columns (limits which status values a client may write, nothing
-- about who or how much). So an owner who writes to the database directly can set selected_contractor_id to any
-- contractor, set status = 'awarded' for a contractor with no quote on the claim and with any amount, and move a
-- claim out of contract_signed. Everything downstream (contract generation, the fee at signing, the commission,
-- and who sees the raw estimate, the measurement report and the street address) trusts those columns.
--
-- Change. One new SECURITY INVOKER trigger function, claims_guard_award_columns(), and one trigger,
-- claims_guard_award_columns, BEFORE UPDATE ON public.claims. For client callers (the test the live claims
-- guards use: current_user is anon or authenticated, the JWT role is not service_role, the caller is not an
-- admin) an UPDATE is refused 42501 when it:
--   1. changes status away from 'contract_signed' (the owner cannot un-sign a signed claim);
--   2. moves status to 'awarded' from any status other than 'active' or 'bidding';
--   3. changes selected_contractor_id or selected_bid_amount, or moves status to 'awarded', unless the
--      resulting selected_contractor_id has a live quote on this claim whose total_price equals
--      selected_bid_amount. Live = quotes.status in ('submitted','selected') and quotes.bid_status 'active'
--      (or NULL). A change that leaves selected_contractor_id NULL is allowed only if selected_bid_amount is NULL
--      and the status is not 'awarded'; clearing an existing selected_contractor_id is refused.
-- A value re-sent unchanged is not a change. The owner reads the claim's quotes through the existing policy
-- "Homeowners can read quotes for their claims", so the check runs as the caller (INVOKER); a quote the caller
-- cannot see counts as no quote, which fails closed.
-- Untouched: service_role (every Edge Function, including switch-contractor and rescind-bid), admins, and
-- owner-level sessions such as accept_bid() (SECURITY DEFINER, postgres-owned, bids.html's award path).
-- The React award (react-app/app/(homeowner)/bids/actions.ts awardClaimToContractor) writes
-- selected_contractor_id = the bid's contractor, selected_bid_amount = the bid's total_price, status = 'awarded'
-- while the bid is still 'submitted'; it passes (proof, pass 5).
--
-- Not changed: any existing trigger or guard function, any policy, any grant, any data, accept_bid() (it still
-- sets 'awarded' without checking the current status; it is a definer function and a separate decision, see the
-- PR body question 2).
--
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS before CREATE TRIGGER. No GRANT or REVOKE.

BEGIN;

CREATE OR REPLACE FUNCTION public.claims_guard_award_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false) THEN

    -- 1. a signed claim cannot be moved to another status by the owner
    IF OLD.status = 'contract_signed' AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'claims: a signed claim cannot be moved to another status by the claim owner (gh-2626)'
        USING ERRCODE = '42501';
    END IF;

    -- 2. awarding is only possible while the claim is open for bids
    IF NEW.status = 'awarded' AND OLD.status IS DISTINCT FROM 'awarded'
       AND COALESCE(OLD.status NOT IN ('active', 'bidding'), true) THEN
      RAISE EXCEPTION 'claims: a claim can only be awarded while it is open for bids (gh-2626)'
        USING ERRCODE = '42501';
    END IF;

    -- 3. the selected contractor and the amount must come from a live quote on this claim
    IF NEW.selected_contractor_id IS DISTINCT FROM OLD.selected_contractor_id
       OR NEW.selected_bid_amount IS DISTINCT FROM OLD.selected_bid_amount
       OR (NEW.status = 'awarded' AND OLD.status IS DISTINCT FROM 'awarded') THEN
      IF NEW.selected_contractor_id IS NULL THEN
        IF OLD.selected_contractor_id IS NOT NULL
           OR NEW.selected_bid_amount IS NOT NULL
           OR NEW.status = 'awarded' THEN
          RAISE EXCEPTION 'claims: the selected contractor can only be set to a contractor with a live bid on this claim, at that bid''s price (gh-2626)'
            USING ERRCODE = '42501';
        END IF;
      ELSIF NOT COALESCE(EXISTS (
               SELECT 1 FROM public.quotes q
                WHERE q.claim_id = OLD.id
                  AND q.contractor_id = NEW.selected_contractor_id
                  AND q.status IN ('submitted', 'selected')
                  AND COALESCE(q.bid_status, 'active') = 'active'
                  AND q.total_price = NEW.selected_bid_amount), false) THEN
        RAISE EXCEPTION 'claims: the selected contractor can only be set to a contractor with a live bid on this claim, at that bid''s price (gh-2626)'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.claims_guard_award_columns() IS
  'gh-2626: BEFORE UPDATE guard on public.claims. Client roles (anon, authenticated) that are not admins cannot move a claim out of contract_signed, cannot award a claim that is not active or bidding, and can change selected_contractor_id, selected_bid_amount or award the claim only to a contractor with a live quote on that claim at that quote''s total_price (42501). An unchanged value is not a change. service_role, admins and owner-level (SECURITY DEFINER) sessions such as accept_bid() are untouched.';

DROP TRIGGER IF EXISTS claims_guard_award_columns ON public.claims;
CREATE TRIGGER claims_guard_award_columns
  BEFORE UPDATE ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.claims_guard_award_columns();

COMMIT;
