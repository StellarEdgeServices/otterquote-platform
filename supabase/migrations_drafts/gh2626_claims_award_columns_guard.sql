-- STATUS (gh-1438, as of 2026-10-13T21:17:36Z): NOT APPLIED
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
-- Proof (throwaway Postgres, six passes; extended 2026-10-13 after REVIEW: FAIL 6155135164, F1/F2): supabase/tests/gh2626_claims_award_columns_guard_proof.sql
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
--      selected_bid_amount. Live = quotes.status 'submitted' and quotes.bid_status 'active'
--      (or NULL). A change that leaves selected_contractor_id NULL is allowed only if selected_bid_amount is NULL
--      and the status is not 'awarded'; clearing an existing selected_contractor_id is refused.
-- A value re-sent unchanged is not a change. The owner reads the claim's quotes through the existing policy
-- "Homeowners can read quotes for their claims", so the check runs as the caller (INVOKER); a quote the caller
-- cannot see counts as no quote, which fails closed.
-- Untouched by THIS trigger: service_role (every Edge Function, including switch-contractor and rescind-bid), admins, and
-- owner-level sessions such as accept_bid() (SECURITY DEFINER, postgres-owned, bids.html's award path); accept_bid()
-- carries its own equivalent checks below (REVIEW F1).
-- The React award (react-app/app/(homeowner)/bids/actions.ts awardClaimToContractor) writes
-- selected_contractor_id = the bid's contractor, selected_bid_amount = the bid's total_price, status = 'awarded'
-- while the bid is still 'submitted'; it passes (proof, pass 5).
--
-- REVIEW 6155135164 (REVIEW: FAIL, F1/F2/F3) and Ben's rulings (DECIDED 1 and 2, on PR #2705 and #2626). Two more
-- objects are re-created in this same file so the set is one atomic apply, each from its LIVE body (production
-- as read 2026-10-13; verbatim from supabase/migrations/20260908180021 and 20261006170000) plus the lines marked gh-2626:
--   * accept_bid(uuid, uuid) (SECURITY DEFINER; owner postgres, so the claims guard above cannot see its caller):
--     DECIDED 1: an expired, withdrawn (cancelled), superseded or otherwise not-active bid is refused by accept_bid()
--     (P0001, bid_not_awardable). DECIDED 2: the claim UPDATE inside it only matches a claim in status active or
--     bidding; a claim in contract_signed (or draft, awarded, waitlisted, ...) is refused (P0001, claim_not_awardable)
--     and is never moved. The rest of the body is unchanged (ownership check, row lock, payment-method check, the
--     quote -> selected write, the decline of the others, the return row, the grants).
--   * quotes_guard_homeowner_columns() (the one guard trigger on quotes): a client caller cannot change
--     quotes.bid_status unless it is the quote's own contractor (the owner, who holds UPDATE on every column through the
--     policy "Homeowners can update quotes for their claims", could revive an expired or withdrawn bid, review F2), and
--     the claim owner can set status to selected only from a submitted bid whose bid_status is active, and to declined
--     only from a submitted or selected bid (review 6155821752 B2). service_role,
--     admins, owner-level definer sessions and the bidding contractor's own paths are untouched.
-- WHAT "LIVE" MEANS, exactly (review F3). In the claims guard (rule 3) a quote is live when status is submitted and
-- bid_status is active or NULL. In accept_bid() it is awardable when bid_status is active or NULL and status
-- is submitted or declined ('selected' is refused in both: a switched-away, refunded contractor stays selected, review
-- 6155821752 B1; declined is kept: switch-contractor leaves the losers of the first award declined
-- and puts the claim back in bidding, so refusing them would break a re-award; PR body question 1). The two quote guards
-- close the path that made "live" beatable: nobody but the bidding contractor, service_role or an admin can move
-- bid_status, and the owner cannot move an expired, cancelled, superseded or declined quote back to selected, nor a draft or expired
-- quote to declined (B2). Known difference (B3): after a switch the earlier bidders are declined, so bids.html (accept_bid)
-- can re-award one, while the React direct write is refused by the claims guard (declined is not submitted).
--
-- CONFLICT WITH THE UNAPPLIED DRAFTS (disclosed, not resolved here). gh2519_quotes_server_set_fee.sql and
-- gh2564_quotes_selected_price_lock.sql also CREATE OR REPLACE quotes_guard_homeowner_columns() (gh2519 also accept_bid())
-- from the same live body WITHOUT these gh-2626 lines. Applied AFTER this file they silently remove them. Before either is
-- applied, carry the lines marked gh-2626 into it, or apply this set last; after any later migration that touches those two
-- functions, run the two SELECTs in the pre-flight (prosrc LIKE '%gh-2626%') and they must both return true.
--
-- Not changed: any other existing trigger or guard function, any policy, any grant, any data.

-- Idempotent: CREATE OR REPLACE FUNCTION (three functions); DROP TRIGGER IF EXISTS before CREATE TRIGGER. No GRANT or REVOKE
-- (CREATE OR REPLACE keeps accept_bid()'s EXECUTE for authenticated and the revoke from PUBLIC and anon).

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
                  AND q.status = 'submitted'
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
  'gh-2626: BEFORE UPDATE guard on public.claims. Client roles (anon, authenticated) that are not admins cannot move a claim out of contract_signed, cannot award a claim that is not active or bidding, and can change selected_contractor_id, selected_bid_amount or award the claim only to a contractor with a live quote on that claim at that quote''s total_price (42501). An unchanged value is not a change. service_role, admins and owner-level (SECURITY DEFINER) sessions such as accept_bid() are untouched by this trigger (accept_bid() carries its own checks, gh-2626).';

DROP TRIGGER IF EXISTS claims_guard_award_columns ON public.claims;
CREATE TRIGGER claims_guard_award_columns
  BEFORE UPDATE ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.claims_guard_award_columns();

-- gh-2626 (F1, DECIDED 1 and 2): accept_bid() refuses a not-active bid and a claim that is not active or bidding.
CREATE OR REPLACE FUNCTION public.accept_bid(p_claim_id uuid, p_quote_id uuid)
RETURNS TABLE (out_claim_id uuid, out_quote_id uuid, out_contractor_id uuid,
               out_amount numeric, out_declined_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_uid uuid := auth.uid(); v_contractor uuid; v_amount numeric; v_declined integer; v_has_pm boolean;
        v_q_status text; v_q_bid_status text; v_rows integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'accept_bid: no authenticated user' USING ERRCODE='28000';
  END IF;

  -- Ownership check + row lock: only the claim's own homeowner may accept a bid on it,
  -- and FOR UPDATE OF q takes the lock in the same statement that authorizes the caller,
  -- so two simultaneous accepts on one claim serialize instead of racing.
  SELECT q.contractor_id, q.total_price, q.status, q.bid_status
    INTO v_contractor, v_amount, v_q_status, v_q_bid_status
    FROM quotes q JOIN claims c ON c.id = q.claim_id
   WHERE q.id = p_quote_id AND q.claim_id = p_claim_id AND c.user_id = v_uid
   FOR UPDATE OF q;

  IF v_contractor IS NULL THEN
    RAISE EXCEPTION 'accept_bid: quote % is not a bid on claim % owned by the caller',
      p_quote_id, p_claim_id USING ERRCODE='42501';
  END IF;

  -- gh-2626 (Ben, DECIDED 1): an expired, withdrawn (cancelled), superseded or otherwise not-active bid is not
  -- awardable by anyone. A bid is awardable only while its bid_status is active (or NULL) and its status is
  -- submitted or declined (declined = the losers of an earlier award in a switched claim). A selected quote is
  -- refused (review 6155821752 B1: a switched-away, refunded contractor stays selected because switch-contractor's
  -- 'cancelled' write fails quotes_status_check, and must not be re-awarded). An expired quote and a draft are refused.
  IF COALESCE(v_q_status, '') NOT IN ('submitted', 'declined')
     OR COALESCE(v_q_bid_status, 'active') <> 'active' THEN
    RAISE EXCEPTION 'bid_not_awardable: this bid is expired, withdrawn or no longer active, so it cannot be accepted'
      USING ERRCODE = 'P0001';
  END IF;

  -- gh-1532: guard the money path -- a bid cannot be accepted for a contractor
  -- with no payment method on file. The BEFORE UPDATE trigger above is the
  -- enforcement point of record (it also covers the React direct-update path
  -- this RPC's HTML callers do not use); this check exists so bids.html and
  -- contractor-about.html get the same readable, ERRCODE-matchable refusal
  -- before the UPDATE below rather than depending on how the trigger's
  -- exception text surfaces back through this SECURITY DEFINER call.
  SELECT has_payment_method INTO v_has_pm FROM contractors WHERE id = v_contractor;
  IF v_has_pm IS NOT TRUE THEN
    RAISE EXCEPTION 'contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet'
      USING ERRCODE = 'P0001';
  END IF;

  -- gh-2626 (Ben, DECIDED 2): only a claim that is open for bids (status active or bidding, the names in
  -- claims_status_check) can be awarded, and a claim is never moved out of contract_signed (or draft, awarded,
  -- waitlisted, ...) by this function. The status test is part of the UPDATE, so it cannot race with a
  -- service_role write (docusign-webhook sets contract_signed) between a read and the write.
  UPDATE claims SET selected_contractor_id = v_contractor,
                    selected_bid_amount    = v_amount,
                    status                 = 'awarded',
                    updated_at             = now()
   WHERE id = p_claim_id AND user_id = v_uid AND status IN ('active', 'bidding');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'claim_not_awardable: this claim is not open for bids, so a bid cannot be accepted on it'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE quotes SET status = 'selected', updated_at = now() WHERE id = p_quote_id;

  WITH d AS (UPDATE quotes q2 SET status = 'declined', updated_at = now()
              WHERE q2.claim_id = p_claim_id AND q2.id <> p_quote_id
                AND q2.status IN ('submitted','draft') RETURNING 1)
  SELECT count(*)::int INTO v_declined FROM d;

  RETURN QUERY SELECT p_claim_id, p_quote_id, v_contractor, v_amount, v_declined;
END $fn$;

-- gh-2626 (F2): the owner may not revive a quote (bid_status) or select anything but a submitted, active bid.
CREATE OR REPLACE FUNCTION public.quotes_guard_homeowner_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false) THEN

    IF TG_OP = 'INSERT' THEN
      -- gh-2479 born state: a client-created quote is the caller's own new bid and nothing later
      IF NOT COALESCE(EXISTS (
               SELECT 1 FROM public.contractors k
                WHERE k.id = NEW.contractor_id AND k.user_id = auth.uid()), false) THEN
        RAISE EXCEPTION 'quotes: a bid can only be created by the contractor it names (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
      IF COALESCE(NEW.status <> 'submitted', true)
         OR COALESCE(NEW.bid_status <> 'active', true)
         OR NEW.is_auto_bid IS TRUE
         OR NEW.renewed_from_quote_id IS NOT NULL
         OR NEW.homeowner_signed_at IS NOT NULL
         OR NEW.contractor_signed_at IS NOT NULL
         OR NEW.payment_status IS NOT NULL THEN
        RAISE EXCEPTION 'quotes: a new bid must start as a submitted, active bid; selection, renewal, signing and payment state are set later by the platform (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;

    IF COALESCE(
         (NEW.claim_id IS DISTINCT FROM OLD.claim_id)
         OR (NEW.contractor_id IS DISTINCT FROM OLD.contractor_id),
         true) THEN
      RAISE EXCEPTION 'quotes: claim_id and contractor_id can only be changed by service_role or an admin (gh-2479)'
        USING ERRCODE = '42501';
    END IF;

    IF COALESCE(NEW.total_price IS DISTINCT FROM OLD.total_price, true)
       AND NOT COALESCE(EXISTS (
             SELECT 1 FROM public.contractors k
              WHERE k.id = OLD.contractor_id AND k.user_id = auth.uid()), false) THEN
      RAISE EXCEPTION 'quotes: total_price can only be changed by the bidding contractor, service_role or an admin (gh-2519)'
        USING ERRCODE = '42501';
    END IF;

    IF COALESCE(NEW.status IS DISTINCT FROM OLD.status, true)
       AND NOT COALESCE(
             NEW.status IN ('selected', 'declined')
             AND EXISTS (
               SELECT 1 FROM public.claims c
                WHERE c.id = OLD.claim_id AND c.user_id = auth.uid()), false) THEN
      RAISE EXCEPTION 'quotes: status can only be set to selected or declined by the claim owner; other changes need service_role or an admin (gh-2479)'
        USING ERRCODE = '42501';
    END IF;

    -- gh-2519: the fee columns. Only the bid's own contractor may change them (the bid forms send all four on
    -- a change-bid save). The claim owner, who holds UPDATE on every column through the policy "Homeowners can
    -- update quotes for their claims", never writes them: no client page does. fee_amount is derived from
    -- platform_fee_pct by quotes_normalize_fee_amount(), which fires after this guard and sees what this
    -- guard let through.
    IF COALESCE(
         (NEW.fee_amount IS DISTINCT FROM OLD.fee_amount)
         OR (NEW.fee_percentage IS DISTINCT FROM OLD.fee_percentage)
         OR (NEW.platform_fee_pct IS DISTINCT FROM OLD.platform_fee_pct)
         OR (NEW.platform_fee_basis IS DISTINCT FROM OLD.platform_fee_basis),
         true)
       AND NOT COALESCE(EXISTS (
             SELECT 1 FROM public.contractors k
              WHERE k.id = OLD.contractor_id AND k.user_id = auth.uid()), false) THEN
      RAISE EXCEPTION 'quotes: fee_amount, fee_percentage, platform_fee_pct and platform_fee_basis can only be changed by the bidding contractor, service_role or an admin (gh-2519)'
        USING ERRCODE = '42501';
    END IF;

    -- gh-2626: the owner may not revive a quote. bid_status (active / expired / superseded / cancelled) is the
    -- bidding contractor's own state and the platform's (process-bid-expirations, rescind-bid: service_role);
    -- no owner-side page writes it (grep in the PR body). Only the quote's own contractor, service_role or an
    -- admin may change it.
    IF COALESCE(NEW.bid_status IS DISTINCT FROM OLD.bid_status, true)
       AND NOT COALESCE(EXISTS (
             SELECT 1 FROM public.contractors k
              WHERE k.id = OLD.contractor_id AND k.user_id = auth.uid()), false) THEN
      RAISE EXCEPTION 'quotes: bid_status can only be changed by the bidding contractor, service_role or an admin (gh-2626)'
        USING ERRCODE = '42501';
    END IF;

    -- gh-2626: the owner selects a bid only from a submitted bid whose bid_status is active. An expired,
    -- withdrawn (cancelled), superseded or declined bid cannot be moved back to selected by the owner.
    IF NEW.status = 'selected' AND OLD.status IS DISTINCT FROM 'selected'
       AND (OLD.status IS DISTINCT FROM 'submitted' OR COALESCE(OLD.bid_status, 'active') <> 'active') THEN
      RAISE EXCEPTION 'quotes: only a submitted, active bid can be selected by the claim owner (gh-2626)'
        USING ERRCODE = '42501';
    END IF;

    -- gh-2626 (review 6155821752 B2): the owner may mark a bid declined only from submitted or selected. A draft
    -- (never submitted) or expired quote cannot be relabelled declined and then accepted through accept_bid().
    IF NEW.status = 'declined' AND OLD.status IS DISTINCT FROM 'declined'
       AND COALESCE(OLD.status NOT IN ('submitted', 'selected'), true) THEN
      RAISE EXCEPTION 'quotes: only a submitted or selected bid can be declined by the claim owner (gh-2626)'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.quotes_guard_homeowner_columns() IS
  'gh-2479 / gh-2519: BEFORE INSERT OR UPDATE guard on public.quotes. Client roles (anon, authenticated) that are not admins: on INSERT can create only their own bid (contractor_id is a contractor row of the caller) born status submitted, bid_status active, not an auto-bid, not a renewal, with no signing or payment state; on UPDATE cannot change claim_id or contractor_id, can change total_price, fee_amount, fee_percentage, platform_fee_pct and platform_fee_basis only as the quote''s own contractor, and can change status only as the claim owner and only to selected (and to selected only from a submitted bid whose bid_status is active) or declined (to declined only from a submitted or selected bid), and can change bid_status only as the quote''s own contractor (gh-2626). Rejected 42501; an unchanged value is not a change. service_role, admins and owner-level (SECURITY DEFINER) sessions such as accept_bid() are untouched.';

COMMIT;
