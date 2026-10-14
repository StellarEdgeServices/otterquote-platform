-- STATUS (gh-1438, as of 2026-10-13T21:17:36Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2626_claims_award_columns_guard (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: written by gh-2626; the forward file creates the trigger and function dropped here and replaces accept_bid() and quotes_guard_homeowner_columns(), whose LIVE bodies (supabase/migrations/20260908180021 and 20261006170000, production as read 2026-10-13) are restored verbatim below
-- REPO COPY: none in supabase/migrations/ (this is a manual reference rollback)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2626 ROLLBACK for supabase/migrations_drafts/gh2626_claims_award_columns_guard.sql
--
-- Manual reference only. Never rename this into a 14-digit timestamp or move it into
-- supabase/migrations/ -- the CLI would replay it FORWARD and undo the guard it exists to revert.
-- Drops the trigger and its function and restores accept_bid() and quotes_guard_homeowner_columns() to the live bodies they had before the forward file. IF gh2519_quotes_server_set_fee or gh2564_quotes_selected_price_lock has been applied since, this file REFUSES (the order gate below raises while quotes_platform_fee_for() exists): roll gh2564 and gh2519 back first (gh2564_..._rollback.sql, then gh2519_quotes_server_set_fee_rollback_to_gh2626.sql), then run this file. Rolling back re-opens the accept_bid() and quote-revival paths and the direct write of claims.selected_contractor_id,
-- selected_bid_amount and status = 'awarded' for the claim owner. No data is touched. If the forward file was
-- applied through the ledger, also delete its supabase_migrations.schema_migrations row.

BEGIN;

-- Order gate (REVIEW 6162070214 B3): run after gh2519 / gh2564 this rollback would restore the pre-gh-2519 function bodies and silently remove the server-set fee and the price lock.
-- Roll gh2564 and gh2519 back first (gh2564_..._rollback.sql, then gh2519_quotes_server_set_fee_rollback_to_gh2626.sql).
DO $order$
BEGIN
  IF to_regprocedure('public.quotes_platform_fee_for(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '%: gh2519 (public.quotes_platform_fee_for) is applied; this rollback would silently remove the server-set fee and the price lock. Roll gh2564 and gh2519 back first', 'gh2626 rollback';
  END IF;
END
$order$;

DROP TRIGGER IF EXISTS claims_guard_award_columns ON public.claims;
DROP FUNCTION IF EXISTS public.claims_guard_award_columns();

-- accept_bid(): live body before gh-2626 (CREATE OR REPLACE keeps its grants)
CREATE OR REPLACE FUNCTION public.accept_bid(p_claim_id uuid, p_quote_id uuid)
RETURNS TABLE (out_claim_id uuid, out_quote_id uuid, out_contractor_id uuid,
               out_amount numeric, out_declined_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_uid uuid := auth.uid(); v_contractor uuid; v_amount numeric; v_declined integer; v_has_pm boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'accept_bid: no authenticated user' USING ERRCODE='28000';
  END IF;

  -- Ownership check + row lock: only the claim's own homeowner may accept a bid on it,
  -- and FOR UPDATE OF q takes the lock in the same statement that authorizes the caller,
  -- so two simultaneous accepts on one claim serialize instead of racing.
  SELECT q.contractor_id, q.total_price INTO v_contractor, v_amount
    FROM quotes q JOIN claims c ON c.id = q.claim_id
   WHERE q.id = p_quote_id AND q.claim_id = p_claim_id AND c.user_id = v_uid
   FOR UPDATE OF q;

  IF v_contractor IS NULL THEN
    RAISE EXCEPTION 'accept_bid: quote % is not a bid on claim % owned by the caller',
      p_quote_id, p_claim_id USING ERRCODE='42501';
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

  UPDATE claims SET selected_contractor_id = v_contractor,
                    selected_bid_amount    = v_amount,
                    status                 = 'awarded',
                    updated_at             = now()
   WHERE id = p_claim_id AND user_id = v_uid;

  UPDATE quotes SET status = 'selected', updated_at = now() WHERE id = p_quote_id;

  WITH d AS (UPDATE quotes q2 SET status = 'declined', updated_at = now()
              WHERE q2.claim_id = p_claim_id AND q2.id <> p_quote_id
                AND q2.status IN ('submitted','draft') RETURNING 1)
  SELECT count(*)::int INTO v_declined FROM d;

  RETURN QUERY SELECT p_claim_id, p_quote_id, v_contractor, v_amount, v_declined;
END $fn$;

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
