-- ROLLBACK for 20260904233727_gh1532_accept_bid_payment_guard.sql
--
-- Drops the BEFORE UPDATE trigger + its function, then restores accept_bid()
-- to the exact live body captured via
-- pg_get_functiondef('public.accept_bid'::regproc) before the forward
-- migration was authored (md5 8566312d2c641ca6355d229ec5b7199f; see
-- pre-flight.md). No data loss -- no claims/quotes/contractors rows are
-- altered by either half of the forward migration or by this rollback; only
-- the trigger's presence/absence and accept_bid()'s body change.

DROP TRIGGER IF EXISTS claims_payment_method_guard ON public.claims;
DROP FUNCTION IF EXISTS public.claims_enforce_payment_method_on_award();

CREATE OR REPLACE FUNCTION public.accept_bid(p_claim_id uuid, p_quote_id uuid)
RETURNS TABLE (out_claim_id uuid, out_quote_id uuid, out_contractor_id uuid,
               out_amount numeric, out_declined_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_uid uuid := auth.uid(); v_contractor uuid; v_amount numeric; v_declined integer;
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
