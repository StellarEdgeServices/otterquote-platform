-- gh-2564 (D-369): once the homeowner selects a bid, its price and fee are locked for every browser caller.
-- STATUS (gh-1438, as of 2026-10-08T00:01:23Z): NOT APPLIED
-- EVIDENCE: drafted by the cto62-fee worker under ruling 6048924192 on #2564 (Dustin, 2026-10-06, "Lock (Recommended)", registered D-369); production read-only at 2026-10-08T00:01:23Z: quotes_guard_homeowner_columns() prosrc md5 f6102d1c…, which has no status clause
-- REPO COPY: none in supabase/migrations/ (not applied). Rollback and pre-flight: supabase/migrations_rollbacks/gh2564_quotes_selected_price_lock_rollback.sql and gh2564_quotes_selected_price_lock_pre-flight.md
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (review, R-177, R-097 24-hour notice, recorded apply).
-- Proof (throwaway Postgres, beside failing controls on today's schema): supabase/tests/gh2519_gh2564_fee_lock_proof.sql
--
-- REQUIRES gh2519_quotes_server_set_fee.sql APPLIED FIRST, and NEVER applied without it (the DO block after BEGIN raises if
-- quotes_platform_fee_for() or the gh2519 index is missing, or if no bid can be rescinded). This file re-creates the same guard function: its body is
-- gh2519_quotes_server_set_fee.sql's body plus two blocks, both marked gh-2564. Applied on its own it would also bring in every
-- gh-2519 rule and would fail at the first bid, because quotes_platform_fee_for() would not exist.
--
-- The rule. For client callers (anon / authenticated, not service_role, not an admin), on a bid whose status
-- is selected before or after the write, a change to any of these is refused 42501:
--   total_price, fee_amount, fee_percentage, platform_fee_pct, platform_fee_basis, card_fee_cents,
--   decking_price_per_sheet, full_redeck_price, per_trade_breakdown,
--   and, D-381 (extends D-369; Dustin 2026-10-08 "Freeze terms too (Recommended)"): trade_type, value_adds,
--   workmanship_warranty_years, warranty_option_id, warranty_snapshot, scope_summary.
-- The price and fee column list is the builder's proposal (D-369 left "which columns and statuses" open): the
-- eight price and fee columns named in ruling 6048924192 plus per_trade_breakdown, which holds the per-trade
-- prices of a multi-trade bid. The terms list is D-381's "trade, warranty and value-adds" translated to
-- columns, plus two the CTO added and states in the PR body: warranty_snapshot (the stored text of the
-- warranty option; leaving it free would let the warranty change under a locked warranty_option_id) and
-- scope_summary (bids.html reads start date, completion time, brand and declarations out of it for the bid
-- card the homeowner selects on, and create-docusign-envelope copies brand and start date from it into the
-- contract, so it is what the homeowner selected on; D-381 left scope undecided, CEO 6050257042 asked the
-- CTO to lock it only if so). Each is one line to remove. notes stays writable, as does auto_renew,
-- supplement_acknowledged, fee_accepted_at and both signature stamps. A value re-sent unchanged is not a
-- change, so "Update Bid" with the same numbers and terms still saves.
-- The bid's own contractor's fee fields on a selected bid are pinned to their stored values, fee_amount
-- included, before the check (the gh-2519 server-set step would otherwise recompute fee_amount).
-- Who can still change a selected bid's price and fee: service_role (every Edge Function, including
-- docusign-webhook and its contract-price check), admins, and owner-level SECURITY DEFINER functions.
-- The way out for a contractor is rescind and re-bid (D-369). See the pre-flight: rescind-bid must be shown
-- to work on a selected bid, and the bid form must show its message, BEFORE this is applied.
-- Idempotent: CREATE OR REPLACE FUNCTION. No new function, trigger, table, policy or data change.

BEGIN;

-- gh-2564 apply gate (re-review 6051423781 finding 7). This file must never be applied without gh2519 and never before a
-- working rescind path exists (CEO 6050104316: "no lock before rescind-bid works on production"). The block raises, and
-- nothing is applied, unless:
--   (a) public.quotes_platform_fee_for(uuid, uuid) exists (gh2519 is applied; without it every browser bid fails),
--   (b) the gh2519 index quotes_one_selected_bid_per_claim exists (the gh2519 of THIS review, not an older head), and
--   (c) quotes_bid_status_check admits the bid_status value that rescind-bid writes. c_rescind_bid_writes is that value
--       as read from supabase/functions/rescind-bid/index.ts (L197: 'rescinded'; production's constraint allows only
--       active, expired, superseded, cancelled, so today this block raises). Whoever repairs rescind-bid sets this
--       constant to the value the repaired function writes; (c) is necessary, not sufficient: the pre-flight still requires
--       a rescind of an is_test selected bid to be shown succeeding.
DO $gate$
DECLARE c_rescind_bid_writes CONSTANT text := 'rescinded';
BEGIN
  IF to_regprocedure('public.quotes_platform_fee_for(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'gh2564: gh2519_quotes_server_set_fee.sql is not applied (public.quotes_platform_fee_for(uuid, uuid) does not exist); applying this file alone would refuse every browser bid';
  END IF;
  IF to_regclass('public.quotes_one_selected_bid_per_claim') IS NULL THEN
    RAISE EXCEPTION 'gh2564: the index quotes_one_selected_bid_per_claim does not exist; apply the current gh2519_quotes_server_set_fee.sql first';
  END IF;
  IF position(quote_literal(c_rescind_bid_writes) IN COALESCE((SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = 'public.quotes'::regclass AND conname = 'quotes_bid_status_check'), '')) = 0 THEN
    RAISE EXCEPTION 'gh2564: rescind-bid writes bid_status %, which quotes_bid_status_check does not admit, so no bid can be rescinded; this lock would leave a contractor no way to change a selected bid (D-369). Repair the rescind path first.', quote_literal(c_rescind_bid_writes);
  END IF;
END
$gate$;

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
      IF COALESCE(OLD.status IN ('selected', 'awarded'), false)
         OR COALESCE(NEW.status IN ('selected', 'awarded'), false) THEN
        -- gh-2564 (D-369): on a selected bid the fee is frozen, fee_amount included
        NEW.platform_fee_pct   := OLD.platform_fee_pct;
        NEW.fee_percentage     := OLD.fee_percentage;
        NEW.platform_fee_basis := OLD.platform_fee_basis;
        NEW.fee_amount         := OLD.fee_amount;
      ELSE
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
    -- or rescinded (bid_status not active) is not live and does not block; any such leftover selected, active bid is
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
         AND q3.status = 'selected' AND q3.bid_status = 'active';
    END IF;

    -- gh-2564 (D-369, Dustin 2026-10-06: "Lock (Recommended)"; D-381, Dustin 2026-10-08: "Freeze terms too
    -- (Recommended)"): once the homeowner has selected a bid, its price, fee and terms are frozen for every browser caller. A contractor who needs a different number rescinds
    -- and re-bids. service_role (every Edge Function, the contract-price check in docusign-webhook included),
    -- admins and owner-level SECURITY DEFINER functions never reach this branch.
    IF (COALESCE(OLD.status IN ('selected', 'awarded'), false)
        OR COALESCE(NEW.status IN ('selected', 'awarded'), false))
       AND COALESCE(
             (NEW.total_price IS DISTINCT FROM OLD.total_price)
             OR (NEW.fee_amount IS DISTINCT FROM OLD.fee_amount)
             OR (NEW.fee_percentage IS DISTINCT FROM OLD.fee_percentage)
             OR (NEW.platform_fee_pct IS DISTINCT FROM OLD.platform_fee_pct)
             OR (NEW.platform_fee_basis IS DISTINCT FROM OLD.platform_fee_basis)
             OR (NEW.card_fee_cents IS DISTINCT FROM OLD.card_fee_cents)
             OR (NEW.decking_price_per_sheet IS DISTINCT FROM OLD.decking_price_per_sheet)
             OR (NEW.full_redeck_price IS DISTINCT FROM OLD.full_redeck_price)
             OR (NEW.per_trade_breakdown IS DISTINCT FROM OLD.per_trade_breakdown)
             -- gh-2564 / D-381: the terms the price buys
             OR (NEW.trade_type IS DISTINCT FROM OLD.trade_type)
             OR (NEW.value_adds IS DISTINCT FROM OLD.value_adds)
             OR (NEW.workmanship_warranty_years IS DISTINCT FROM OLD.workmanship_warranty_years)
             OR (NEW.warranty_option_id IS DISTINCT FROM OLD.warranty_option_id)
             OR (NEW.warranty_snapshot IS DISTINCT FROM OLD.warranty_snapshot)
             OR (NEW.scope_summary IS DISTINCT FROM OLD.scope_summary),
             true) THEN
      RAISE EXCEPTION 'quotes: the price, fee and terms of a selected bid are locked; to change them, rescind the bid and submit a new one (gh-2564)'
        USING ERRCODE = '42501';
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
  'gh-2479 / gh-2519 / gh-2564: BEFORE INSERT OR UPDATE guard on public.quotes. Client roles (anon, authenticated) that are not admins: on INSERT can create only their own bid (contractor_id is a contractor row of the caller) born status submitted, bid_status active, not an auto-bid, not a renewal, with no signing, payment, test, envelope, cancellation, expiry or warranty-upload state, and the server sets platform_fee_pct, fee_percentage, platform_fee_basis and fee_amount from quotes_platform_fee_for() whatever the browser sent; on UPDATE cannot change claim_id or contractor_id, can change total_price only as the quote''s own contractor (whose three rate fields then keep their stored values and whose fee_amount is recomputed from total_price), cannot change the fee columns as anyone else, can change status only as the claim owner, only to selected or declined, and to selected only when the claim has no live selected bid (selected, active, and the claim''s current selected contractor; a switched-away or rescinded bid does not count and is set to declined), and can change no column outside the caller''s allow-list (owner: status, homeowner_signed_at; contractor: the bid-form columns and contractor_signed_at). gh-2564 (D-369): on a selected bid no client caller can change total_price, fee_amount, fee_percentage, platform_fee_pct, platform_fee_basis, card_fee_cents, decking_price_per_sheet, full_redeck_price, per_trade_breakdown, or (D-381) trade_type, value_adds, workmanship_warranty_years, warranty_option_id, warranty_snapshot or scope_summary. Rejected 42501; an unchanged value is not a change. service_role, admins and owner-level (SECURITY DEFINER) sessions such as accept_bid() are untouched.';

COMMIT;
