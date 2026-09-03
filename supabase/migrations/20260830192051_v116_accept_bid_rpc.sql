-- gh-1293 criterion 5: atomic bid acceptance.
-- bids.html:2110-2133 and contractor-about.html:958-967 each perform the same three
-- unbatched client-side .update() calls with no transaction, which left a durable
-- half-state in production once already (quote 0a334300 selected, claim 8dcf76f1 never
-- updated to match -- cleaned up as part of this change). This RPC does all three writes
-- in one statement with an ownership check and a row lock, so two simultaneous accepts on
-- one claim serialize instead of racing.
--
-- Proven against production inside a forced-rollback transaction before this file was
-- applied: 4/4 cases (HAPPY, OWNERSHIP-wrong-caller, CROSS-CLAIM, ANON), trigger
-- log_bid_accepted() fires through the RPC (activity_log + notifications both increment
-- in-txn), production re-verified unchanged after each probe.
--
-- Applied to production as this same file's timestamp (20260830192051) before being
-- committed here -- see migration-filename-lint.py's backfill convention (gh-1307).

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
