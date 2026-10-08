-- Rollback for supabase/migrations_drafts/gh2564_quotes_selected_price_lock.sql (gh-2564, D-369).
-- WARNING: this RE-OPENS the selected bid: the bidding contractor can again change the price, the decking and
-- redeck prices and the per-trade prices of a bid the homeowner has already selected.
-- It restores quotes_guard_homeowner_columns() to the body of gh2519_quotes_server_set_fee.sql, byte for byte, with its
-- comment. Every gh-2519 rule stays in force. The trigger is untouched. No data is lost.
-- If the migration was applied, also delete its supabase_migrations.schema_migrations row.
BEGIN;

CREATE OR REPLACE FUNCTION public.quotes_guard_homeowner_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
DECLARE
  -- gh-2519 TIER C SWITCH (ruling 6049007305, "NOT DECIDED"): which rate does a REVISED bid carry if the
  -- configured rate changed after the bid was first submitted?
  --   false = the rate stored on the bid when it was submitted stays (what happens today; the build default,
  --           and the CTO's recommended answer under D-214 / D-215);
  --   true  = the revised bid takes the rate configured at the time of the revision.
  -- Either answer is this ONE line. Nothing else in the function changes.
  c_revised_bid_takes_current_config_rate CONSTANT boolean := false;
  v_is_contractor boolean;
  v_is_owner      boolean;
  v_fee_pct       numeric;
  v_fee_basis     text;
  v_allowed       text[];
  v_refused       text;
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

      -- gh-2519 residual 3, on INSERT: the columns neither bid form sends, which carry test, payment,
      -- signing-envelope, cancellation, expiry or warranty-upload state, must be born at their defaults.
      IF COALESCE(NEW.is_test, true)
         OR NEW.payment_intent_id IS NOT NULL
         OR NEW.payment_method_id IS NOT NULL
         OR NEW.payment_method_type IS NOT NULL
         OR NEW.card_fee_cents IS NOT NULL
         OR NEW.docusign_envelope_id IS NOT NULL
         OR NEW.cancelled_at IS NOT NULL
         OR NEW.cancellation_reason IS NOT NULL
         OR NEW.expires_at IS NOT NULL
         OR NEW.expired_at IS NOT NULL
         OR NEW.warranty_document_url IS NOT NULL
         OR NEW.warranty_uploaded_at IS NOT NULL THEN
        RAISE EXCEPTION 'quotes: a new bid cannot carry test, payment, envelope, cancellation, expiry or warranty-upload state; those are set later by the platform (gh-2519)'
          USING ERRCODE = '42501';
      END IF;

      -- gh-2519: the server sets the fee on every browser-written bid. Whatever the browser sent in
      -- platform_fee_pct, fee_percentage, platform_fee_basis and fee_amount is OVERWRITTEN (not refused, so
      -- both live bid forms keep working unchanged) from the fee config row for this contractor and claim.
      SELECT f.fee_pct, f.fee_basis INTO v_fee_pct, v_fee_basis
        FROM public.quotes_platform_fee_for(NEW.contractor_id, NEW.claim_id) f;
      IF v_fee_pct IS NULL OR v_fee_basis IS NULL THEN
        -- no rate is invented here: with no config row the bid is not saved
        RAISE EXCEPTION 'quotes: no platform fee is configured for this bid, so it cannot be saved (gh-2519)'
          USING ERRCODE = 'P0001';
      END IF;
      NEW.platform_fee_pct   := v_fee_pct;
      NEW.fee_percentage     := v_fee_pct;
      NEW.platform_fee_basis := v_fee_basis;
      NEW.fee_amount         := round((v_fee_pct / 100.0) * NEW.total_price, 2);
      RETURN NEW;
    END IF;

    IF COALESCE(
         (NEW.claim_id IS DISTINCT FROM OLD.claim_id)
         OR (NEW.contractor_id IS DISTINCT FROM OLD.contractor_id),
         true) THEN
      RAISE EXCEPTION 'quotes: claim_id and contractor_id can only be changed by service_role or an admin (gh-2479)'
        USING ERRCODE = '42501';
    END IF;

    v_is_contractor := COALESCE(EXISTS (
        SELECT 1 FROM public.contractors k
         WHERE k.id = OLD.contractor_id AND k.user_id = auth.uid()), false);
    v_is_owner := COALESCE(EXISTS (
        SELECT 1 FROM public.claims c
         WHERE c.id = OLD.claim_id AND c.user_id = auth.uid()), false);

    -- gh-2519: on the bid's own contractor's UPDATE the server sets the fee. The three rate fields keep
    -- their stored values (or take the configured rate, per the Tier C switch above) and fee_amount is
    -- recomputed from the new total_price. Whatever the browser sent in the four fields is OVERWRITTEN.
    -- A legacy row with no platform_fee_pct keeps it NULL; its fee_amount is computed from fee_percentage.
    IF v_is_contractor THEN
      IF c_revised_bid_takes_current_config_rate THEN
        SELECT f.fee_pct, f.fee_basis INTO v_fee_pct, v_fee_basis
          FROM public.quotes_platform_fee_for(OLD.contractor_id, OLD.claim_id) f;
        IF v_fee_pct IS NULL OR v_fee_basis IS NULL THEN
          RAISE EXCEPTION 'quotes: no platform fee is configured for this bid, so it cannot be saved (gh-2519)'
            USING ERRCODE = 'P0001';
        END IF;
        NEW.platform_fee_pct   := v_fee_pct;
        NEW.fee_percentage     := v_fee_pct;
        NEW.platform_fee_basis := v_fee_basis;
      ELSE
        NEW.platform_fee_pct   := OLD.platform_fee_pct;
        NEW.fee_percentage     := OLD.fee_percentage;
        NEW.platform_fee_basis := OLD.platform_fee_basis;
      END IF;
      NEW.fee_amount := round((COALESCE(NEW.platform_fee_pct, NEW.fee_percentage) / 100.0) * NEW.total_price, 2);
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
    -- a change-bid save), and for that contractor the server has already set them above. The claim owner,
    -- who holds UPDATE on every column through the policy "Homeowners can update quotes for their claims",
    -- never writes them: no client page does.
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

    -- gh-2519 residual 4: one selected bid per claim. A client may set a bid to selected only when the claim has no
    -- LIVE selected bid: a bid with status selected, bid_status active, whose contractor is the claim's current
    -- selected contractor. A bid that was switched away from (the claim has no selected contractor, or another one)
    -- or rescinded (bid_status not active) is not live and does not block; any such leftover selected bid (any bid_status) is
    -- set to declined here so that the partial unique index quotes_one_selected_bid_per_claim holds. Re-review
    -- 6051423781 findings 1 and 3. Two simultaneous selects are closed by that index, not by this check.
    IF COALESCE(NEW.status IN ('selected', 'awarded'), false)
       AND NOT COALESCE(OLD.status IN ('selected', 'awarded'), false) THEN
      IF EXISTS (
             SELECT 1 FROM public.quotes q2
               JOIN public.claims cl ON cl.id = q2.claim_id
              WHERE q2.claim_id = OLD.claim_id AND q2.id <> OLD.id
                AND q2.status IN ('selected', 'awarded')
                AND q2.bid_status = 'active'
                AND cl.selected_contractor_id IS NOT NULL
                AND q2.contractor_id = cl.selected_contractor_id) THEN
        RAISE EXCEPTION 'quotes: another bid on this claim is already selected; a second bid cannot be selected beside it (gh-2519)'
          USING ERRCODE = '42501';
      END IF;
      UPDATE public.quotes q3 SET status = 'declined', updated_at = now()
       WHERE q3.claim_id = OLD.claim_id AND q3.id <> OLD.id
         AND q3.status = 'selected';
    END IF;

    -- gh-2519 residual 3: column allow-list. Whatever else changed must be a column this caller's pages
    -- write today. The claim owner: status (judged above) and homeowner_signed_at. The bid's own contractor:
    -- the columns the two bid forms send on a change-bid save, and contractor_signed_at. Everything else
    -- (payment_status, payment_intent_id, is_test, bid_status, fee_accepted_at for the owner, and the rest)
    -- is refused. A value re-sent unchanged is not a change.
    v_allowed := ARRAY['updated_at'];
    IF v_is_owner THEN
      v_allowed := v_allowed || ARRAY['status', 'homeowner_signed_at'];
    END IF;
    IF v_is_contractor THEN
      v_allowed := v_allowed || ARRAY[
        'total_price', 'fee_percentage', 'fee_amount', 'platform_fee_pct', 'platform_fee_basis', 'fee_accepted_at',
        'scope_summary', 'notes', 'decking_price_per_sheet', 'full_redeck_price', 'supplement_acknowledged',
        'trade_type', 'value_adds', 'per_trade_breakdown', 'auto_renew',
        'warranty_option_id', 'warranty_snapshot', 'workmanship_warranty_years',
        'contractor_signed_at'];
    END IF;
    SELECT string_agg(n.key, ', ' ORDER BY n.key) INTO v_refused
      FROM jsonb_each(to_jsonb(NEW)) n
      JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
     WHERE n.value IS DISTINCT FROM o.value
       AND NOT (n.key = ANY (v_allowed));
    IF v_refused IS NOT NULL THEN
      RAISE EXCEPTION 'quotes: % can only be changed by service_role or an admin (gh-2519)', v_refused
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.quotes_guard_homeowner_columns() IS
  'gh-2479 / gh-2519: BEFORE INSERT OR UPDATE guard on public.quotes. Client roles (anon, authenticated) that are not admins: on INSERT can create only their own bid (contractor_id is a contractor row of the caller) born status submitted, bid_status active, not an auto-bid, not a renewal, with no signing, payment, test, envelope, cancellation, expiry or warranty-upload state, and the server sets platform_fee_pct, fee_percentage, platform_fee_basis and fee_amount from quotes_platform_fee_for() whatever the browser sent; on UPDATE cannot change claim_id or contractor_id, can change total_price only as the quote''s own contractor (whose three rate fields then keep their stored values and whose fee_amount is recomputed from total_price), cannot change the fee columns as anyone else, can change status only as the claim owner, only to selected or declined, and to selected only when the claim has no live selected bid (selected, active, and the claim''s current selected contractor; a switched-away or rescinded bid does not count and is set to declined), and can change no column outside the caller''s allow-list (owner: status, homeowner_signed_at; contractor: the bid-form columns and contractor_signed_at). Rejected 42501; an unchanged value is not a change. service_role, admins and owner-level (SECURITY DEFINER) sessions such as accept_bid() are untouched.';

COMMIT;
