-- gh-2519 proof: quotes.total_price / fee columns guard.
-- Run against production (yeszghaspzwwstvsrioa) in ONE transaction that is forced to roll back.
--   BEFORE the fix : run this file alone.
--   AFTER the fix  : run the migration body (20261005170000_gh2519_quotes_price_columns_guard.sql with its own
--                    BEGIN; / COMMIT; lines removed, so nothing can commit) followed by this file, in the same
--                    single statement batch.
-- Fixture: picks ONE is_test quote with status='submitted' whose claim has an owner and whose contractor has a
-- user_id. Writes nothing outside the transaction; the last statement is a deliberate RAISE EXCEPTION, so the
-- whole batch (migration DDL included) rolls back; the raw findings are the exception text.
-- Expected BEFORE: P1 ACCEPTED (the bug), P5 ACCEPTED, P7 ACCEPTED; P2 rows=0; P3/P4/P6/P8 ACCEPTED.
-- Expected AFTER : P1 REJECTED 42501 and price unchanged; P5 REJECTED 42501; P7 REJECTED 42501;
--                  P2 rows=0 (unchanged); P3/P4/P6/P8 ACCEPTED (legitimate paths and controls unchanged).

CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', p_role, 'email', 'gh2519-proof@example.invalid')::text, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row changed)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 90);
  END;
END $f$;

DO $proof$
DECLARE
  v_q uuid; v_claim uuid; v_owner uuid; v_con_user uuid; v_price numeric; v_fee numeric;
  v_stranger uuid := gen_random_uuid();
  v_out text := '';
BEGIN
  SELECT q.id, q.claim_id, cl.user_id, c.user_id, q.total_price, q.fee_amount
    INTO v_q, v_claim, v_owner, v_con_user, v_price, v_fee
    FROM public.quotes q
    JOIN public.claims cl ON cl.id = q.claim_id AND cl.is_test AND cl.user_id IS NOT NULL
    JOIN public.contractors c ON c.id = q.contractor_id AND c.user_id IS NOT NULL
   WHERE q.is_test AND q.status = 'submitted'
   ORDER BY q.created_at DESC LIMIT 1;
  IF v_q IS NULL THEN RAISE EXCEPTION 'GH2519_FIXTURE_MISSING: no is_test submitted quote with owner + contractor user'; END IF;
  v_out := v_out || format(E'\nFIXTURE quote=%s total_price=%s fee_amount=%s', left(v_q::text, 8), v_price, v_fee);

  -- P1: the bug. Claim owner raises the price past the $10,000 floor.
  v_out := v_out || E'\nP1 OWNER UPDATE total_price=99999: ' ||
    pg_temp.try_as('authenticated', v_owner, format('UPDATE public.quotes SET total_price = 99999 WHERE id = %L', v_q));
  v_out := v_out || E'\nP1 RESULT total_price now=' || (SELECT total_price::text FROM public.quotes WHERE id = v_q) || ' (original ' || v_price || ')';
  UPDATE public.quotes SET total_price = v_price, fee_amount = v_fee WHERE id = v_q;  -- reset as postgres (exempt)

  -- P2 negative control: a different authenticated user
  v_out := v_out || E'\nP2 CONTROL stranger UPDATE total_price=99999: ' ||
    pg_temp.try_as('authenticated', v_stranger, format('UPDATE public.quotes SET total_price = 99999 WHERE id = %L', v_q));

  -- P5: fee input, same owner
  v_out := v_out || E'\nP5 OWNER UPDATE fee_amount=0: ' ||
    pg_temp.try_as('authenticated', v_owner, format('UPDATE public.quotes SET fee_amount = 0, platform_fee_pct = 0 WHERE id = %L', v_q));
  UPDATE public.quotes SET total_price = v_price, fee_amount = v_fee WHERE id = v_q;

  -- P6 no collateral: owner changes a non-price column
  v_out := v_out || E'\nP6 OWNER UPDATE notes (non-price column): ' ||
    pg_temp.try_as('authenticated', v_owner, format('UPDATE public.quotes SET notes = %L WHERE id = %L', 'gh2519 proof', v_q));

  -- P3 legitimate path: the bidding contractor revises their own pre-award bid (price + fee), as change-bid does
  v_out := v_out || E'\nP3 CONTRACTOR revises own submitted bid total_price=' || (v_price + 100) || ': ' ||
    pg_temp.try_as('authenticated', v_con_user, format('UPDATE public.quotes SET total_price = %s, updated_at = now() WHERE id = %L', v_price + 100, v_q));
  v_out := v_out || E'\nP3 RESULT total_price now=' || (SELECT total_price::text FROM public.quotes WHERE id = v_q);
  -- P4: change-bid payload that re-sends unchanged values (renew-style resend)
  v_out := v_out || E'\nP4 CONTRACTOR resend unchanged columns: ' ||
    pg_temp.try_as('authenticated', v_con_user, format(
      'UPDATE public.quotes SET total_price = total_price, fee_percentage = fee_percentage, platform_fee_pct = platform_fee_pct, platform_fee_basis = platform_fee_basis, updated_at = now() WHERE id = %L', v_q));
  UPDATE public.quotes SET total_price = v_price, fee_amount = v_fee WHERE id = v_q;

  -- P8: service_role (Edge Functions) may still write
  v_out := v_out || E'\nP8 SERVICE_ROLE UPDATE total_price: ' ||
    pg_temp.try_as('service_role', v_owner, format('UPDATE public.quotes SET total_price = %s WHERE id = %L', v_price + 1, v_q));
  UPDATE public.quotes SET total_price = v_price, fee_amount = v_fee WHERE id = v_q;

  -- P7: post-award lock. Quote goes 'selected' (as accept_bid would); contractor then tries to reprice
  UPDATE public.quotes SET status = 'selected' WHERE id = v_q;
  v_out := v_out || E'\nP7 CONTRACTOR reprices a SELECTED quote total_price=99999: ' ||
    pg_temp.try_as('authenticated', v_con_user, format('UPDATE public.quotes SET total_price = 99999 WHERE id = %L', v_q));
  v_out := v_out || E'\nP7 RESULT total_price now=' || (SELECT total_price::text FROM public.quotes WHERE id = v_q);
  v_out := v_out || E'\nP7b CONTRACTOR non-price write on SELECTED quote (payment_status): ' ||
    pg_temp.try_as('authenticated', v_con_user, format('UPDATE public.quotes SET updated_at = now() WHERE id = %L', v_q));

  RAISE EXCEPTION E'GH2519_FORCED_ROLLBACK%', v_out;
END
$proof$;
