-- Migration: 20261005170000_gh2519_quotes_price_columns_guard
-- GitHub: #2519 (MONEY, SECURITY), origin: refuter-sideways finding 4 on PR #2502 (the other input of the #2479 commission).
-- Tier: 3B (new trigger on public.quotes). Protective only (R-134): it only removes capability. No GRANT/REVOKE,
--       no policy change, no change to any existing function, no user-facing wording.
-- NOT APPLIED by the authoring session or by CI. R-097 notice applies.
-- Rollback: supabase/migrations_rollbacks/20261005170000_gh2519_quotes_price_columns_guard_rollback.sql
-- Proof (rolled-back, is_test rows only): supabase/tests/gh2519_quotes_price_guard_proof.sql
--
-- Problem (CTO RUN 58, production read 2026-10-03): policy "Homeowners can update quotes for their claims" lets a
-- signed-in claim owner UPDATE any column of any quote on their claim, including total_price. The $10,000 floor in
-- apply_referral_commission() (a selected/awarded quote with total_price >= 10000) reads that same column, so the
-- floor is client-controlled. fee_amount / fee_percentage / platform_fee_pct / platform_fee_basis (the platform-fee
-- inputs) are writable the same way.
--
-- Fix: BEFORE UPDATE guard on public.quotes (SECURITY INVOKER, so current_user is the caller). For client roles
-- (anon, authenticated) that are not service_role and not admins, a CHANGE to any of
--   total_price, fee_amount, fee_percentage, platform_fee_pct, platform_fee_basis
-- is rejected with 42501 unless BOTH hold:
--   (1) the caller is the quote's own contractor (contractors.user_id = auth.uid() AND contractors.id = OLD.contractor_id), and
--   (2) the quote is not yet awarded: OLD.status NOT IN ('selected', 'awarded').
-- "Change" means NEW.col IS DISTINCT FROM OLD.col. Re-sending the stored value is not a change and succeeds, so the
-- contractor change-bid / renew payloads that resend unchanged columns keep working.
--
-- LEGITIMATE WRITERS OF THESE COLUMNS (enumerated by grep on origin/main 1fd6fc44; command + output are in the PR body):
--   - contractor-bid-form.html ~L5486-5517 (_changeBidPayload) and react-app/app/contractor/bid/[claimId]/bid-form.tsx
--     ~L326 via buildQuoteUpdate() (utils.ts ~L455): the contractor revising/renewing their OWN bid, role authenticated.
--     KEPT: caller is the quote's contractor and the quote is pre-award (status 'submitted'). The renew path also
--     passes (status stays 'submitted', bid_status 'expired').
--   - INSERT paths (contractor-bid-form.html ~L5579, bid-form.tsx ~L358, process-auto-bids, process-bid-expirations):
--     untouched, this trigger is UPDATE-only. (Contractors keep their INSERT policy.)
--   - Edge Functions with the service-role client (create-payment-intent, process-dunning, docusign-webhook,
--     create-docusign-envelope, rescind-bid, process-bid-expirations, stripe-webhook, record-warranty-upload,
--     approve-warranty-drift): none writes the five columns on UPDATE; and service_role is exempt regardless.
--   - SQL functions: accept_bid() (SECURITY DEFINER) writes status/updated_at only; definer sessions are exempt
--     (current_user is not anon/authenticated). quotes_normalize_fee_amount recomputes fee_amount inside the same
--     statement; this guard sorts BEFORE it by trigger name (quotes_enforce_..., quotes_guard_..., quotes_normalize_...),
--     so it sees the caller's raw payload, and an unchanged-price contractor save is unaffected either way.
--   - Homeowner client writes to quotes touch status / bid_status / homeowner_signed_at only
--     (bids/actions.ts, contract-signing hooks). Not affected.
--
-- BEHAVIOUR CHANGE (the point of the migration, all of it): a homeowner (or any non-owner authenticated user) can no
-- longer change the five columns on any quote; a contractor can no longer change them on their own quote after it is
-- 'selected'/'awarded'. Nothing else changes.
-- A column REVOKE was not used: quotes carries table-level UPDATE for authenticated, and the contractor path needs
-- the same columns, so a revoke cannot express "only the bid's own contractor, only pre-award".
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS before CREATE TRIGGER.
--
-- Not in this migration (named so they are not lost): a client can still write quotes.status / bid_status /
-- payment_status / is_test (same policies); a homeowner who is ALSO the bidding contractor can still price their
-- own pre-award bid (that is a legitimate bid); the floor in apply_referral_commission() still reads a client-reachable
-- quote status. Those need their own issue.

BEGIN;

CREATE OR REPLACE FUNCTION public.quotes_guard_price_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false)
     AND (   NEW.total_price       IS DISTINCT FROM OLD.total_price
          OR NEW.fee_amount        IS DISTINCT FROM OLD.fee_amount
          OR NEW.fee_percentage    IS DISTINCT FROM OLD.fee_percentage
          OR NEW.platform_fee_pct  IS DISTINCT FROM OLD.platform_fee_pct
          OR NEW.platform_fee_basis IS DISTINCT FROM OLD.platform_fee_basis) THEN
    IF NOT (
         EXISTS (SELECT 1 FROM public.contractors c
                  WHERE c.id = OLD.contractor_id
                    AND c.user_id = (SELECT auth.uid()))
         AND COALESCE(OLD.status, '') NOT IN ('selected', 'awarded')
       ) THEN
      RAISE EXCEPTION 'quotes: total_price and fee columns can only be changed by the bidding contractor before the quote is selected, or by service_role or an admin (gh-2519)'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.quotes_guard_price_columns() IS
  'gh-2519: BEFORE UPDATE guard on public.quotes. Client roles (anon, authenticated) that are not admins cannot change total_price, fee_amount, fee_percentage, platform_fee_pct or platform_fee_basis (rejected 42501; an unchanged value is not a change) unless they are the quote''s own contractor and the quote is not yet selected/awarded. service_role, admins and owner-level (definer) sessions are untouched.';

DROP TRIGGER IF EXISTS quotes_guard_price_columns ON public.quotes;

CREATE TRIGGER quotes_guard_price_columns
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.quotes_guard_price_columns();

COMMIT;
