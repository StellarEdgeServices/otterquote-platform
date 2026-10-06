-- Rollback for 20261005200000_gh2479_born_state_guard.sql (gh-2479).
-- WARNING: this RE-OPENS the born-state routes of #2479 (CLOSE-REVIEW: FAIL 6000637783): a client can
-- again INSERT a claim born 'contract_signed' (or UPDATE its own claim to 'contract_signed'), and a
-- contractor can again INSERT a quote born 'selected' or flagged is_auto_bid on any claim, each of which
-- lets a $200 referral commission accrue on a job that never existed. Run it only if a guard blocks a
-- legitimate writer, and re-close the hole as soon as that writer is moved to service_role.
-- It restores the two functions to the bodies of 20261003193000 (claims) and 20261005170000 (quotes),
-- byte for byte, with their comments, and narrows the quotes trigger back to BEFORE UPDATE. The trigger
-- is narrowed BEFORE the function is restored, so the old body is never called for an INSERT.
-- It does NOT remove the guards of those two earlier migrations (their own rollback files do that).
-- If this migration was applied, also delete its supabase_migrations.schema_migrations row.
BEGIN;

CREATE OR REPLACE TRIGGER quotes_guard_homeowner_columns
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.quotes_guard_homeowner_columns();

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
    ELSIF COALESCE(
         (NEW.referral_id IS DISTINCT FROM OLD.referral_id)
         OR (NEW.completion_date IS DISTINCT FROM OLD.completion_date)
         OR (NEW.created_at IS DISTINCT FROM OLD.created_at),
         true) THEN
      RAISE EXCEPTION 'claims: referral_id, completion_date and created_at can only be changed by service_role or an admin (gh-2479)'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.claims_guard_referral_columns() IS
  'gh-2479: BEFORE INSERT OR UPDATE guard on public.claims. Client roles (anon, authenticated) that are not admins cannot change referral_id, completion_date or created_at on UPDATE (rejected 42501; an unchanged value is not a change) and get created_at = now() on INSERT. service_role, admins and owner-level sessions are untouched.';

COMMIT;
