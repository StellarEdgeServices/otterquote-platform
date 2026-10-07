-- Migration: 20261006170000_gh2519_quotes_fee_columns_guard
-- GitHub: #2519 (MONEY, SECURITY). Supersedes PR #2538 (REVIEW: FAIL 6020152846, LEGAL-READ: FAIL 6020156346,
--         returned by the CEO in 6020250023: only the protective half is rebuilt here).
-- Tier: 3B (replaces one existing guard function on a money-path table). Protective only (R-134): it only
--       removes capability from the claim owner. No trigger is added or changed.
-- NOT APPLIED by the authoring session or by CI. R-097 notice applies.
-- Rollback: supabase/migrations_rollbacks/20261006170000_gh2519_quotes_fee_columns_guard_rollback.sql
-- Pre-flight: supabase/migrations/20261006170000_gh2519_quotes_fee_columns_guard_pre-flight.md
-- Proof (rolled-back, is_test rows only): supabase/tests/gh2519_quotes_fee_columns_guard_proof.sql
--
-- Problem. The first half of #2519 (quotes.total_price) is already closed on production by
-- 20261005170000_gh2479_quotes_homeowner_guard (#2537). The other half of the issue body is the fee columns.
-- The policy "Homeowners can update quotes for their claims" has no column restriction and `authenticated`
-- holds UPDATE on every column, so a claim owner can still write quotes.fee_amount, fee_percentage,
-- platform_fee_pct and platform_fee_basis on any quote of their own claim. platform_fee_pct is the rate
-- docusign-webhook, create-payment-intent and create-invoice charge; normalize_quotes_fee_amount() derives
-- fee_amount from it.
--
-- Rule (added INSIDE the existing quotes_guard_homeowner_columns(), after the status rule; nothing else
-- in the function changes, byte for byte). For client callers (the same test the function already uses:
-- current_user is anon or authenticated, the JWT role is not service_role, the caller is not an admin) an
-- UPDATE that changes fee_amount, fee_percentage, platform_fee_pct or platform_fee_basis is refused 42501
-- unless the caller is the quote's own contractor (contractors.id = OLD.contractor_id AND user_id =
-- auth.uid(); contractor_id is frozen by the first rule, so nobody can make themselves that contractor).
-- That is the same exception the total_price rule already makes. A value re-sent unchanged is not a change.
-- service_role (every Edge Function), admins and SECURITY DEFINER functions owned by postgres (accept_bid())
-- are untouched.
--
-- No client page writes these columns as the claim owner: the owner's quotes writes are status
-- (selected / declined), homeowner_signed_at (contract signing). See the pre-flight for the enumeration.
--
-- This migration EXTENDS the existing guard function. It adds no function and no trigger, so the CI check
-- tests/gh2479-static-born-state-guard.mjs (exactly one guard trigger on quotes; every earlier rule kept)
-- still holds.
--
-- NOT in this migration (each needs a decision or is a separate change; see the pre-flight):
--   - any lock on the bidding contractor's price or fee columns after the quote is selected (PR #2538's
--     status clause; no decision backs it; the CEO sent it to Dustin as its own question);
--   - the bidding contractor's own platform_fee_pct / fee_percentage before selection, and the browser-chosen
--     fee values on INSERT (they need a server-held rate to compare against);
--   - payment_status, payment_intent_id, is_test, bid_status and the other columns of quotes;
--   - the owner flipping a losing bid of $10,000 or more to selected beside the real winner.
--
-- Idempotent: CREATE OR REPLACE FUNCTION. No DROP, GRANT, REVOKE, policy, trigger or table change.

BEGIN;

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
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.quotes_guard_homeowner_columns() IS
  'gh-2479 / gh-2519: BEFORE INSERT OR UPDATE guard on public.quotes. Client roles (anon, authenticated) that are not admins: on INSERT can create only their own bid (contractor_id is a contractor row of the caller) born status submitted, bid_status active, not an auto-bid, not a renewal, with no signing or payment state; on UPDATE cannot change claim_id or contractor_id, can change total_price, fee_amount, fee_percentage, platform_fee_pct and platform_fee_basis only as the quote''s own contractor, and can change status only as the claim owner and only to selected or declined. Rejected 42501; an unchanged value is not a change. service_role, admins and owner-level (SECURITY DEFINER) sessions such as accept_bid() are untouched.';

COMMIT;
