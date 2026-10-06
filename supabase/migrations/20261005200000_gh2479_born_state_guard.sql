-- Migration: 20261005200000_gh2479_born_state_guard
-- GitHub: #2479 (MONEY, SECURITY; CLOSE-REVIEW: FAIL comment 6000637783, routes E1, E3 and E7).
-- Tier: 3B (replaces two guard trigger functions; widens one trigger from UPDATE to INSERT OR UPDATE).
--       Protective only (R-134): it only removes capability.
-- NOT APPLIED by the authoring session or by CI. R-097 notice applies.
-- Rollback: supabase/migrations_rollbacks/20261005200000_gh2479_born_state_guard_rollback.sql
-- Pre-flight: supabase/migrations/20261005200000_gh2479_born_state_guard_pre-flight.md
-- Proof (rolled-back, is_test rows only): supabase/tests/gh2479_born_state_guard_proof.sql
--
-- Problem (proven on production 2026-10-05 by the second independent refuter of #2479, after the quotes
-- guard 20261005170000 was applied). The two guards compare NEW to OLD on UPDATE only. Nothing looks at
-- the state a row is BORN in, and nothing looks at claims.status at all:
--   E3  one signed-in user with an active contractor login INSERTs a claim that carries a referral of
--       their choosing and is born status = 'contract_signed', INSERTs their own bid on it, selects it as
--       the claim owner, and marks the job complete. mark-job-complete accepts a claim that is
--       'contract_signed' or 'awarded' with a selected quote of the caller's, and
--       apply_referral_commission() accrues $200. No job, no contract, no payment ever existed.
--   E1  a contractor INSERTs a quote born status = 'selected' on another user's claim. That row satisfies
--       mark-job-complete's "you have a won job on this claim" check and the commission's "selected quote
--       of at least $10,000" check.
--   E7  the same INSERT with is_auto_bid = true also skips the D-199 bid gate
--       (enforce_bid_can_submit() returns early for auto-bids).
-- A born-state rule on claims alone would be empty: the owner could INSERT the claim in its initial state
-- and then UPDATE status = 'contract_signed' (policy "Users can update own claims" has no column
-- restriction). So the claims.status rule covers UPDATE as well (section 1b).
--
-- This migration EXTENDS the two existing guard functions. It adds no trigger function and no second
-- trigger on either table (CTO ruling on #2304 5998798693: two guards on one table drift).
-- "Client caller" below is the same test both functions already use: current_user is anon or
-- authenticated, the JWT role is not service_role, and the caller is not an admin. service_role (every
-- Edge Function), admins, and SECURITY DEFINER functions owned by postgres (accept_bid() among them:
-- current_user is the owner there) are untouched.
--
-- 1. public.claims_guard_referral_columns()  (trigger claims_guard_referral_columns, BEFORE INSERT OR
--    UPDATE on public.claims, unchanged).
--    Kept byte for byte: created_at := now() on INSERT; referral_id, completion_date and created_at
--    frozen on UPDATE.
--    1a. NEW, INSERT. A client-created claim must be born in an initial state:
--          status                 IN ('documents_needed', 'draft')
--          selected_contractor_id IS NULL
--          selected_bid_amount    IS NULL
--          completion_date        IS NULL
--          contract_signed_at     IS NULL
--        Otherwise 42501. The two client INSERTs of claims (trade-selector.html ~L1465 and
--        react-app/app/trade-selector/page.tsx ~L1016) send none of these five columns, so the row takes
--        the column default status = 'documents_needed' and NULL for the other four. 'draft' is allowed
--        as well: it is the other pre-submission value in claims_status_check, the value
--        react-app/app/(homeowner)/repair-intake/utils.ts buildClaimInsert() builds (not called today,
--        gh-2004), and nothing downstream treats a draft claim as biddable, awardable or completable.
--        An explicit NULL status is refused (fails closed).
--        referral_id on INSERT stays ALLOWED: the homeowner funnel stamps the click-chain referral on
--        the new claim row and nowhere else (#567); the hole was the late status, not the referral.
--    1b. NEW, UPDATE. claims.status can CHANGE only to a value a client page writes today:
--          'active'      submit for bids (dashboard.html ~L3231, react dashboard/actions.ts ~L41)
--          'waitlisted'  state gate    (dashboard.html ~L1919, react dashboard/actions.ts ~L244)
--          'submitted'   repair intake (repair-intake.html ~L1326, react use-repair-intake-data.ts ~L176)
--          'awarded'     React award   (react (homeowner)/bids/actions.ts ~L111; the static pages award
--                                       through accept_bid(), a definer RPC that never reaches this arm)
--        A change to 'contract_signed', 'bidding', 'draft', 'documents_needed' or NULL is refused 42501.
--        Those are written only by service_role: 'contract_signed' by docusign-webhook and
--        process-dunning, 'bidding' by switch-contractor and process-dunning. A re-sent unchanged status
--        is not a change and succeeds. The FROM state is not restricted: no client flow is known to
--        depend on one, and restricting it would be a behaviour change this task cannot prove safe.
--
-- 2. public.quotes_guard_homeowner_columns()  (trigger quotes_guard_homeowner_columns, widened from
--    BEFORE UPDATE to BEFORE INSERT OR UPDATE on public.quotes).
--    Kept byte for byte: the three UPDATE rules of 20261005170000 (claim_id / contractor_id frozen,
--    total_price only by the quote's contractor, status only selected / declined by the claim owner).
--    NEW, INSERT. A client-created quote:
--          contractor_id          must be a contractor row whose user_id is the caller (the INSERT policy
--                                 already says so; repeated here so the rule does not rest on one policy)
--          status                 = 'submitted'   (the column default; explicit NULL refused)
--          bid_status             = 'active'      (the column default)
--          is_auto_bid            IS NOT TRUE     (true is process-auto-bids, service_role)
--          renewed_from_quote_id  IS NULL         (set only by process-bid-expirations, service_role; a
--                                                  client value would skip enforce_bid_window_expiry())
--          homeowner_signed_at, contractor_signed_at, payment_status  IS NULL
--        Otherwise 42501. The two client INSERTs of quotes (contractor-bid-form.html ~L5578 and
--        react-app/app/contractor/bid/[claimId]/bid-form.tsx ~L358 via utils.ts buildQuoteInsert()) send
--        is_auto_bid = false and none of the other columns.
--    Trigger order on INSERT (BEFORE triggers fire in name order): quotes_enforce_bid_can_submit, then
--    this guard, then quotes_normalize_fee_amount and trg_enforce_bid_window_expiry. A bid refused by the
--    D-199 gate today is still refused by it first, with the same message.
--
-- NOT in this migration:
--   - any rule about self-referral or about a contractor bidding on their own claim (a business decision
--     on Dustin's board, #2479 comment 5999296292). See the pre-flight "Residual": the same single user
--     can still reach an 'awarded' claim through the product's own award and have it marked complete.
--   - the fee columns of quotes (#2519, PR #2538, Kevin).
--   - is_test, ready_for_bids and the other columns a client can still set at INSERT.
--
-- Idempotent: CREATE OR REPLACE FUNCTION; CREATE OR REPLACE TRIGGER. No DROP, GRANT, REVOKE, policy or
-- table change. The function is replaced BEFORE the trigger is widened, inside one transaction, so the
-- old body is never called for an INSERT.

BEGIN;

CREATE OR REPLACE FUNCTION public.claims_guard_referral_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false) THEN
    IF TG_OP = 'INSERT' THEN
      -- the window anchor is server time, never a browser-supplied value
      NEW.created_at := now();
      -- gh-2479 born state: a client-created claim starts at the beginning of the flow
      IF COALESCE(NEW.status NOT IN ('documents_needed', 'draft'), true)
         OR NEW.selected_contractor_id IS NOT NULL
         OR NEW.selected_bid_amount IS NOT NULL
         OR NEW.completion_date IS NOT NULL
         OR NEW.contract_signed_at IS NOT NULL THEN
        RAISE EXCEPTION 'claims: a new claim must start in its initial state; status, selected contractor, bid amount, signing and completion are set later by the platform (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      IF COALESCE(
           (NEW.referral_id IS DISTINCT FROM OLD.referral_id)
           OR (NEW.completion_date IS DISTINCT FROM OLD.completion_date)
           OR (NEW.created_at IS DISTINCT FROM OLD.created_at),
           true) THEN
        RAISE EXCEPTION 'claims: referral_id, completion_date and created_at can only be changed by service_role or an admin (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
      -- gh-2479 born state: without this an initial-state INSERT plus one UPDATE reaches the same row
      IF COALESCE(NEW.status IS DISTINCT FROM OLD.status, true)
         AND NOT COALESCE(NEW.status IN ('active', 'waitlisted', 'submitted', 'awarded'), false) THEN
        RAISE EXCEPTION 'claims: status can only be changed to active, waitlisted, submitted or awarded by the claim owner; other changes need service_role or an admin (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.claims_guard_referral_columns() IS
  'gh-2479: BEFORE INSERT OR UPDATE guard on public.claims. Client roles (anon, authenticated) that are not admins: on INSERT get created_at = now() and must create the claim in an initial state (status documents_needed or draft; no selected contractor, bid amount, signing or completion date); on UPDATE cannot change referral_id, completion_date or created_at, and can change status only to active, waitlisted, submitted or awarded. Rejected 42501; an unchanged value is not a change. service_role, admins and owner-level sessions are untouched.';

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
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.quotes_guard_homeowner_columns() IS
  'gh-2479 / gh-2519: BEFORE INSERT OR UPDATE guard on public.quotes. Client roles (anon, authenticated) that are not admins: on INSERT can create only their own bid (contractor_id is a contractor row of the caller) born status submitted, bid_status active, not an auto-bid, not a renewal, with no signing or payment state; on UPDATE cannot change claim_id or contractor_id, can change total_price only as the quote''s own contractor, and can change status only as the claim owner and only to selected or declined. Rejected 42501; an unchanged value is not a change. service_role, admins and owner-level (SECURITY DEFINER) sessions such as accept_bid() are untouched.';

-- CREATE OR REPLACE TRIGGER (PostgreSQL 14+; production is 17.6): the guard is widened in place and is
-- never absent, not even inside this transaction.
CREATE OR REPLACE TRIGGER quotes_guard_homeowner_columns
  BEFORE INSERT OR UPDATE ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.quotes_guard_homeowner_columns();

COMMIT;
