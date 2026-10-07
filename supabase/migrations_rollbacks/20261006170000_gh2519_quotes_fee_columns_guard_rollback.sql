-- Rollback for 20261006170000_gh2519_quotes_fee_columns_guard.sql (gh-2519).
-- WARNING: this RE-OPENS the fee columns of #2519: the claim owner can again write quotes.fee_amount,
-- fee_percentage, platform_fee_pct and platform_fee_basis on a quote of their own claim. Run it only if the
-- rule blocks a legitimate writer, and re-close the hole as soon as that writer is moved to service_role.
-- It restores quotes_guard_homeowner_columns() to the body of 20261005200000_gh2479_born_state_guard.sql,
-- byte for byte, with its comment. The trigger is untouched (this migration did not change it), so the
-- INSERT arm and every earlier rule stay in force.
-- If this migration was applied, also delete its supabase_migrations.schema_migrations row.
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
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.quotes_guard_homeowner_columns() IS
  'gh-2479 / gh-2519: BEFORE INSERT OR UPDATE guard on public.quotes. Client roles (anon, authenticated) that are not admins: on INSERT can create only their own bid (contractor_id is a contractor row of the caller) born status submitted, bid_status active, not an auto-bid, not a renewal, with no signing or payment state; on UPDATE cannot change claim_id or contractor_id, can change total_price only as the quote''s own contractor, and can change status only as the claim owner and only to selected or declined. Rejected 42501; an unchanged value is not a change. service_role, admins and owner-level (SECURITY DEFINER) sessions such as accept_bid() are untouched.';

COMMIT;
