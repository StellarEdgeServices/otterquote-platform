-- gh-1532 second half: guard the money path against awarding a bid to a
-- contractor with no payment method on file. Dispatched separately from the
-- CHECK-constraint half (PR #1627) per the CTO's ruling on the issue that the
-- constraint is hygiene and this is the live money defect (comment 5545336759,
-- 2026-09-04T19:13:53Z): "Ship it as a BEFORE UPDATE trigger on the awarded
-- transition, not as an RPC-body guard alone... react-app/app/(homeowner)/
-- bids/actions.ts (awardClaimToContractor) writes status='awarded' through
-- three direct client .update() calls and never calls accept_bid at all."
--
-- Enforcement design (single point, both surfaces):
--
--   1. BEFORE UPDATE trigger on public.claims, firing only on the transition
--      INTO status='awarded' (OLD.status IS DISTINCT FROM 'awarded' AND
--      NEW.status = 'awarded'). Reads NEW.selected_contractor_id -- the
--      column both accept_bid() (20260830192051_v116_accept_bid_rpc.sql,
--      "UPDATE claims SET selected_contractor_id = v_contractor, ...,
--      status = 'awarded'") and the React path
--      (react-app/app/(homeowner)/bids/actions.ts:109-114,
--      awardClaimToContractor: "supabase.from('claims').update({
--      selected_contractor_id: bid.contractor_id, selected_bid_amount:
--      bid.total_price, status: 'awarded' })") set in the SAME UPDATE
--      statement that flips status -- so it is available on NEW without a
--      join through quotes, and without any dependency on which caller (the
--      RPC or the React direct-update path) performed the write. Looks up
--      contractors.has_payment_method for that id and RAISE EXCEPTION
--      (ERRCODE P0001, matching this codebase's existing convention for
--      trigger-raised business-rule gates -- see
--      20260101000000_v000_baseline_schema.sql's enforce_bid_window_expiry()
--      and 20260501004321_v65_d199_bid_can_submit.sql's D-199 bid gate) when
--      it is not true (false or NULL, fail-closed). This is the ONE
--      enforcement point and it covers bids.html:2106, contractor-about.html:963
--      (both call accept_bid) and the React direct-update path -- none of
--      which can bypass it, because none of them can flip claims.status to
--      'awarded' without going through this table's own UPDATE path.
--
--   2. A readable check inside accept_bid() itself, before the status flip,
--      so the HTML callers get the same human-readable refusal without
--      depending on how the trigger's exception text happens to surface
--      through a nested SECURITY DEFINER call. Same message text, same
--      ERRCODE. accept_bid()'s SECURITY DEFINER posture and the rest of its
--      body are otherwise byte-for-byte unchanged from
--      20260830192051_v116_accept_bid_rpc.sql -- the live body was captured
--      via pg_get_functiondef('public.accept_bid'::regproc) before this
--      change (md5 8566312d2c641ca6355d229ec5b7199f; full text and the
--      rolled-back proof transcript are in the companion pre-flight.md,
--      the same text the rollback file below restores verbatim).
--
-- Canonical flag: contractors.has_payment_method (boolean). Live state per
-- the CTO's dispatch, reconfirmed in the pre-flight below: 13 contractors,
-- all is_test, exactly 1 with has_payment_method = true.
--
-- Existing awarded rows are NOT retro-invalidated: the trigger only fires on
-- the transition INTO 'awarded' (OLD.status IS DISTINCT FROM NEW.status),
-- never on a row that is merely re-saved while already 'awarded', and never
-- on SELECT of existing rows. Live state: 1 existing claims.status='awarded'
-- row; confirmed untouched by the proof transaction (see pre-flight.md).
--
-- Proven in a single BEGIN...ROLLBACK transaction against production before
-- this file was written: negative test refused 2/2 (via accept_bid() RPC
-- and via the React direct-UPDATE shape, both against an is_test contractor
-- with has_payment_method=false), positive test succeeded 2/2 (same two
-- shapes, against the one is_test contractor with has_payment_method=true).
-- Nothing persisted -- see pre-flight.md for the full transcript and the
-- post-rollback verification queries.
--
-- Rollback: 20260904233727_gh1532_accept_bid_payment_guard_rollback.sql
-- Pre-flight: 20260904233727_gh1532_accept_bid_payment_guard_pre-flight.md
--
-- tier:3b, MONEY path. NOT APPLIED by this session -- apply_migration was
-- never called and no DDL ran outside a rolled-back transaction; this PR
-- ships the authored forward + rollback + pre-flight only. Merge/apply is
-- @exec:cto's after Dustin's R-120 signed review.

CREATE OR REPLACE FUNCTION public.claims_enforce_payment_method_on_award()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_has_pm boolean;
BEGIN
  IF NEW.status = 'awarded' AND OLD.status IS DISTINCT FROM 'awarded' THEN
    IF NEW.selected_contractor_id IS NULL THEN
      RAISE EXCEPTION 'contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT has_payment_method INTO v_has_pm
      FROM public.contractors
     WHERE id = NEW.selected_contractor_id;

    IF v_has_pm IS NOT TRUE THEN
      RAISE EXCEPTION 'contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS claims_payment_method_guard ON public.claims;
CREATE TRIGGER claims_payment_method_guard
  BEFORE UPDATE ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.claims_enforce_payment_method_on_award();

-- RPC-side readable check, inserted before the status-flip UPDATE. Every
-- other line of this function is byte-for-byte identical to the live body
-- captured via pg_get_functiondef('public.accept_bid'::regproc) (see
-- pre-flight.md for the captured text/md5 the rollback file restores).
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

REVOKE ALL ON FUNCTION public.accept_bid(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_bid(uuid, uuid) TO authenticated;
