-- gh-2803 proof: notes accepted, price refused, everything else byte-identical. Everything runs inside BEGIN ... ROLLBACK; nothing persists.
-- Run where update_selected_bid_notes() AND gh2564 are applied (apply order: gh2564, then gh2803), on an is_test selected quote only (the script picks one).
-- Run on a schema without gh2564 it fails at control B by design: the price edit is accepted, which is the hole gh2564 closes.
-- Controls: A success before signature, B5 refusal after signature. Prints PROOF lines. Any failed check raises and aborts; the final ROLLBACK discards the notes write.
BEGIN;

DO $proof$
DECLARE
  v_quote   uuid;
  v_owner   uuid;   -- auth user of the quote's contractor
  v_other   uuid;   -- auth user of a different contractor
  v_before  text;
  v_after   text;
  v_notes   text;
  v_fp      text;
BEGIN
  IF to_regprocedure('public.update_selected_bid_notes(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'PROOF PRECONDITION: update_selected_bid_notes(uuid,text) is not installed';
  END IF;
  IF NOT (SELECT prosrc LIKE '%gh-2564%' FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure) THEN
    RAISE NOTICE 'PROOF NOTE: gh2564 is not applied; control B is expected to fail below';
  END IF;

  SELECT q.id, k.user_id INTO v_quote, v_owner
    FROM public.quotes q
    JOIN public.contractors k ON k.id = q.contractor_id
    JOIN public.claims c ON c.id = q.claim_id
   WHERE q.status = 'selected' AND q.is_test AND c.is_test AND k.user_id IS NOT NULL
   ORDER BY q.created_at LIMIT 1;
  IF v_quote IS NULL THEN RAISE EXCEPTION 'PROOF PRECONDITION: no is_test selected quote'; END IF;
  SELECT k.user_id INTO v_other FROM public.contractors k
   WHERE k.user_id IS NOT NULL AND k.user_id <> v_owner LIMIT 1;

  -- fingerprint of every column the lock protects, plus status
  v_fp := $f$SELECT md5(to_jsonb(t)::text) FROM (SELECT total_price, fee_amount, fee_percentage, platform_fee_pct, platform_fee_basis,
            card_fee_cents, decking_price_per_sheet, full_redeck_price, per_trade_breakdown, trade_type, bundled_trades, value_adds,
            warranty_option_id, warranty_snapshot, workmanship_warranty_years, scope_summary, status, bid_status
            FROM public.quotes WHERE id = %L) t$f$;
  EXECUTE format(v_fp, v_quote) INTO v_before;

  -- precondition for A: the quote is unsigned (the picked is_test quote may already carry a signature; this is rolled back)
  UPDATE public.quotes SET homeowner_signed_at = NULL WHERE id = v_quote;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- A: notes change accepted
  PERFORM public.update_selected_bid_notes(v_quote, '  gh2803 proof note  ');
  RESET ROLE;
  SELECT notes INTO v_notes FROM public.quotes WHERE id = v_quote;
  IF v_notes IS DISTINCT FROM 'gh2803 proof note' THEN RAISE EXCEPTION 'PROOF A FAILED: notes = %', v_notes; END IF;
  RAISE NOTICE 'PROOF A ok: notes saved by the selected contractor (trimmed)';

  -- B: negative control, the same contractor changes the price directly: refused
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE public.quotes SET total_price = total_price + 1 WHERE id = v_quote;
    RESET ROLE;
    RAISE EXCEPTION 'PROOF B FAILED: direct price change on a selected bid was accepted (gh2564 lock missing?)';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE 'PROOF B ok: direct price change refused 42501';
  END;

  -- B2: another contractor cannot use the function on this quote
  IF v_other IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      PERFORM public.update_selected_bid_notes(v_quote, 'not mine');
      RESET ROLE;
      RAISE EXCEPTION 'PROOF B2 FAILED: a non-owner saved notes';
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE 'PROOF B2 ok: non-owner refused 42501';
    END;
  END IF;

  -- B3: anon cannot execute it
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    PERFORM public.update_selected_bid_notes(v_quote, 'anon');
    RESET ROLE;
    RAISE EXCEPTION 'PROOF B3 FAILED: anon executed the function';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE 'PROOF B3 ok: anon has no EXECUTE';
  END;

  -- B4: over-length notes refused
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.update_selected_bid_notes(v_quote, repeat('x', 501));
    RESET ROLE;
    RAISE EXCEPTION 'PROOF B4 FAILED: 501 characters accepted';
  EXCEPTION WHEN string_data_right_truncation THEN
    RESET ROLE;
    RAISE NOTICE 'PROOF B4 ok: 501 characters refused';
  END;

  -- B5 (LEGAL-READ fix, PR #2844 comment 6254074220): once the homeowner has signed, the same contractor is refused 22023
  -- (A above is the matching success while homeowner_signed_at IS NULL) and the saved notes do not move
  UPDATE public.quotes SET homeowner_signed_at = now() WHERE id = v_quote;
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.update_selected_bid_notes(v_quote, 'rewrite after signing');
    RESET ROLE;
    RAISE EXCEPTION 'PROOF B5 FAILED: notes changed after the homeowner signed';
  EXCEPTION WHEN invalid_parameter_value THEN
    RESET ROLE;
    RAISE NOTICE 'PROOF B5 ok: edit after homeowner signature refused 22023';
  END;
  SELECT notes INTO v_notes FROM public.quotes WHERE id = v_quote;
  IF v_notes IS DISTINCT FROM 'gh2803 proof note' THEN RAISE EXCEPTION 'PROOF B5 FAILED: notes moved to %', v_notes; END IF;

  -- C: price, platform fee, trades, value_adds, warranty (and the rest of the locked set) byte-identical
  EXECUTE format(v_fp, v_quote) INTO v_after;
  IF v_after IS DISTINCT FROM v_before THEN RAISE EXCEPTION 'PROOF C FAILED: fingerprint % -> %', v_before, v_after; END IF;
  RAISE NOTICE 'PROOF C ok: locked-column fingerprint identical (%)', v_after;
END
$proof$;

ROLLBACK;
