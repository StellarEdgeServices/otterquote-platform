-- Migration: 20261005170000_gh2479_quotes_homeowner_guard
-- GitHub: #2479 (MONEY, SECURITY; CLOSE-REVIEW: FAIL comment 5998207363) and #2519 (quotes.total_price client-writable).
-- Tier: 3B (new triggers on quotes and referral_agents). Protective only (R-134): it only removes capability.
-- NOT APPLIED by the authoring session or by CI. R-097 notice applies.
-- Rollback: supabase/migrations_rollbacks/20261005170000_gh2479_quotes_homeowner_guard_rollback.sql
-- Pre-flight: supabase/migrations/20261005170000_gh2479_quotes_homeowner_guard_pre-flight.md
-- Proof (rolled-back, is_test rows only): supabase/tests/gh2479_quotes_guard_proof.sql
--
-- Problem (proven on production 2026-10-05 by the independent refuter of #2479). The guard added by
-- 20261003193000 freezes claims.referral_id, but policy "Homeowners can update quotes for their claims"
-- (UPDATE, authenticated, USING and WITH CHECK both "claim_id IN the caller's claims") has no column
-- restriction and quotes had no BEFORE UPDATE guard. A homeowner could therefore:
--   1. INSERT a second claim carrying a referral of their choosing (a claim INSERT may carry referral_id;
--      the legitimate path needs that), then
--   2. UPDATE quotes SET claim_id = <second claim> on the job's selected quote, so that
--   3. the contractor's ordinary mark-job-complete lands on the second claim and apply_referral_commission()
--      accrues $200 to the chosen referral.
-- The sibling #2519: the same policy let the claim owner write quotes.total_price, the value the $10,000
-- commission floor and the platform fee are computed from.
-- A third finding from the same run: a partner could UPDATE their own referral_agents.agent_type, the
-- column the D-333 no-fee rule (home_inspector earns no referral fee) reads.
--
-- 1. public.quotes_guard_homeowner_columns(), BEFORE UPDATE on public.quotes. Applies only to client
--    callers: current_user is anon or authenticated, the JWT role is not service_role, and the caller is
--    not an admin. For those callers:
--      claim_id, contractor_id : can never CHANGE. No client path changes either. contractor_id is frozen
--                                because the price rule below is keyed on it (a caller must not be able
--                                to make themselves "the quote's contractor").
--      total_price             : can change only when the caller is the quote's own contractor
--                                (contractors.id = OLD.contractor_id AND contractors.user_id = auth.uid()),
--                                which is the bid edit / renewal in contractor-bid-form.html and
--                                react-app/app/contractor/bid/[claimId]/bid-form.tsx. A claim owner cannot.
--      status                  : can change only when the caller owns the quote's claim AND the new value
--                                is 'selected' or 'declined'. Those are the two values the homeowner
--                                award writes (react-app/app/(homeowner)/bids/actions.ts
--                                awardClaimToContractor: winner -> 'selected', the rest -> 'declined').
--                                Any other new value ('draft', 'submitted', 'expired'), and any status
--                                change by a caller who does not own the claim (a contractor included:
--                                no contractor client path writes quotes.status), is refused.
--    A value that is re-sent unchanged is not a change and succeeds. A refused write raises 42501 (loud,
--    same as claims_guard_referral_columns). Every comparison is wrapped so that a NULL result refuses
--    (fails closed).
--    Untouched: service_role (every Edge Function), admins, and SECURITY DEFINER functions owned by
--    postgres, where current_user is the owner and not the caller. public.accept_bid() is one: the static
--    bids.html and contractor-about.html accept a bid through that RPC, so they never reach this guard.
--    SECURITY INVOKER on purpose: current_user must be the caller, and the two ownership lookups run under
--    the caller's own RLS ("Users can view own claims", "Contractors can read own record"); a row the
--    caller cannot see counts as not owned, which refuses.
--    Trigger order: BEFORE triggers fire in name order, so this one runs before
--    quotes_normalize_fee_amount and set_updated_at_quotes and sees the caller's NEW values.
--    NOT restricted here (out of this issue's scope, see the pre-flight "Residuals"): the other columns
--    the homeowner policy leaves writable (fee_amount, payment_status, is_test, bid_status, ...), and a
--    contractor changing total_price on their own quote after it was selected.
--    The policy itself is left as it is: a WITH CHECK cannot compare NEW to OLD, so it cannot express
--    "claim_id unchanged"; the trigger can.
--
-- 2. public.referral_agents_guard_agent_type(), BEFORE UPDATE on public.referral_agents. Client callers
--    (same test as above) cannot CHANGE agent_type. The only client writes of that column are the two
--    admin pages (admin-referrals.html setAgentType, react-app/app/admin/referrals/page.tsx), which are
--    admins and exempt; the partner profile forms (partner-dashboard.html, react-app/app/partner/dashboard)
--    do not send it; register_partner() only INSERTs it; no SQL function in the live public schema UPDATEs
--    it (pg_proc scan 2026-10-05). A separate function rather than an edit of
--    referral_agents_guard_payout_columns(), so this migration does not have to reproduce that function.
--
-- Not in this migration: any rule about self-referral (a business decision, see the PR's QUESTIONS).
--
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS before CREATE TRIGGER. No GRANT, REVOKE,
-- policy or table change.

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
  'gh-2479 / gh-2519: BEFORE UPDATE guard on public.quotes. Client roles (anon, authenticated) that are not admins cannot change claim_id or contractor_id; can change total_price only as the quote''s own contractor; can change status only as the claim owner and only to selected or declined. Rejected 42501; an unchanged value is not a change. service_role, admins and owner-level (SECURITY DEFINER) sessions such as accept_bid() are untouched.';

DROP TRIGGER IF EXISTS quotes_guard_homeowner_columns ON public.quotes;

CREATE TRIGGER quotes_guard_homeowner_columns
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.quotes_guard_homeowner_columns();

CREATE OR REPLACE FUNCTION public.referral_agents_guard_agent_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false)
     AND COALESCE(NEW.agent_type IS DISTINCT FROM OLD.agent_type, true) THEN
    RAISE EXCEPTION 'referral_agents: agent_type can only be changed by service_role or an admin (gh-2479)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.referral_agents_guard_agent_type() IS
  'gh-2479: BEFORE UPDATE guard on public.referral_agents. Client roles (anon, authenticated) that are not admins cannot change agent_type, the column the D-333 no-fee rule reads. Rejected 42501; an unchanged value is not a change. service_role, admins and owner-level sessions are untouched.';

DROP TRIGGER IF EXISTS referral_agents_guard_agent_type ON public.referral_agents;

CREATE TRIGGER referral_agents_guard_agent_type
  BEFORE UPDATE ON public.referral_agents
  FOR EACH ROW
  EXECUTE FUNCTION public.referral_agents_guard_agent_type();

COMMIT;
