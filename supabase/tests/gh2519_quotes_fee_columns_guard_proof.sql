-- gh-2519 proof: quotes fee columns guard (migration 20261006170000_gh2519_quotes_fee_columns_guard.sql),
-- the fee-column rule added inside quotes_guard_homeowner_columns(). Supersedes the proof of PR #2538.
-- Run against production (yeszghaspzwwstvsrioa) in ONE statement batch that is forced to roll back.
--   BEFORE the fix : run this file alone (production without the migration).
--   AFTER the fix, not yet applied : replace the final DO block with one DO block that (1) calls
--                    pg_temp.gh2519_fee_scenario(), (2) EXECUTEs the migration body with its BEGIN; and
--                    COMMIT; lines removed, (3) calls the scenario again, (4) EXECUTEs the rollback file
--                    the same way, (5) calls it a third time, and (6) raises all three texts. The DDL runs
--                    inside the one statement that is forced to fail, so it cannot commit.
--   AFTER the fix, applied : run this file alone again.
-- The last statement is a deliberate RAISE EXCEPTION, so everything the scenario writes rolls back; the raw
-- findings are the exception text. Each group runs inside its own savepoint (a block that raises P0U01 and
-- catches it), so no write feeds a later group. Roles are set the way PostgREST sets them (role +
-- request.jwt.claims) and cleared after each statement.
-- Everything touched is is_test (the FIXTURES line prints it): homeowner f6c14b57 (o), its claims cb and cs,
-- quotes be305d7c (qb, submitted 15000, 5% fee, contractor k2) and 0a334300 (qs), contractors bb07fc40 (k2,
-- login 189b85ad) and 2bc792be (k3). The one is_test=false quote (403940dc) is never addressed.
--
-- Expected BEFORE the migration (the hole): F1, F2, F3, F4, F5 ACCEPTED (F2 also zeroes fee_amount through
--   quotes_normalize_fee_amount()).
-- Expected AFTER: F1-F5 REJECTED 42501 with fee_amount, fee_percentage, platform_fee_pct, platform_fee_basis
--   and status unchanged.
-- Expected the SAME before and after (negative controls and legitimate paths):
--   F0 rows=0 (RLS: a stranger cannot see the row);
--   L1 ACCEPTED (the bid form's change-bid payload from the bid's own contractor, fee columns included),
--   L2 ACCEPTED (same fee values re-sent), L3 ACCEPTED (the owner's award with the fee columns re-sent
--   unchanged), L4 ACCEPTED (owner status=selected), L5 ACCEPTED (owner homeowner_signed_at),
--   L6 ACCEPTED (service_role), L7 ACCEPTED (admin), L8 accept_bid() returns the quote.
-- K1 (the bid's own contractor reprices before selection, fee columns changed to 4%) is ACCEPTED before and
--   after: the guard keeps the contractor exception. That is the residual in the pre-flight, not a bug here.

CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_sql text, p_email text DEFAULT 'gh2519-fee-proof@example.invalid') RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_role = 'anon' THEN json_build_object('role', 'anon')::text
    ELSE json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text END, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row changed)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 100);
  END;
END $f$;

CREATE FUNCTION pg_temp.q_as(p_role text, p_sub uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_role = 'anon' THEN json_build_object('role', 'anon')::text
    ELSE json_build_object('sub', p_sub, 'role', p_role, 'email', 'gh2519-fee-proof@example.invalid')::text END, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql INTO v;
    EXECUTE 'RESET ROLE';
    RETURN COALESCE(v, 'NULL');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 100);
  END;
END $f$;

CREATE FUNCTION pg_temp.gh2519_fee_scenario() RETURNS text
LANGUAGE plpgsql AS $s$
DECLARE
  o        constant uuid := 'f6c14b57-59dc-43ce-b510-04277a71f5af'; -- is_test homeowner
  stranger constant uuid := '6a9ec731-85d4-4076-ae99-bc77829ee393'; -- another is_test homeowner
  cs       constant uuid := '8dcf76f1-f518-4363-a37f-192dec10b9bb'; -- o's claim, bidding
  cb       constant uuid := '374a2053-de6c-4f9a-9974-2e22714a4795'; -- o's claim, bidding
  qb       constant uuid := 'be305d7c-7982-4e37-89a3-95b2ae79ce63'; -- submitted 15000, 5%, 750, contractor k2, claim cb
  qs       constant uuid := '0a334300-2a4a-4ba6-ac77-efea0fa73179'; -- submitted 15000, contractor k2, claim cs
  k2       constant uuid := 'bb07fc40-3607-4f3f-ac44-dffd4ca95111'; k2u constant uuid := '189b85ad-0ab0-4e54-9083-c51c3ef42a1d';
  k3       constant uuid := '2bc792be-b677-4ac1-bc68-94b1561d9757'; -- is_test contractor with has_payment_method = true
  v text := '';
BEGIN
  v := v || E'\nFIXTURES ' || format('owner_is_test=%s claims(cb,cs)_is_test=%s quotes(qb,qs)_is_test=%s contractors(k2,k3)_is_test=%s qb=%s/%s/fee_pct=%s/fee_amt=%s/spct=%s/basis=%s',
    (SELECT is_test FROM profiles WHERE id = o), (SELECT bool_and(is_test) FROM claims WHERE id IN (cb, cs)),
    (SELECT bool_and(is_test) FROM quotes WHERE id IN (qb, qs)), (SELECT bool_and(is_test) FROM contractors WHERE id IN (k2, k3)),
    (SELECT status FROM quotes WHERE id = qb), (SELECT total_price FROM quotes WHERE id = qb), (SELECT fee_percentage FROM quotes WHERE id = qb),
    (SELECT fee_amount FROM quotes WHERE id = qb), (SELECT platform_fee_pct FROM quotes WHERE id = qb), (SELECT platform_fee_basis FROM quotes WHERE id = qb));
  v := v || E'\nGUARDS ' || format('quotes_guard_homeowner_columns=%s guard_has_fee_rule=%s',
    (SELECT count(*) FROM pg_trigger WHERE tgname = 'quotes_guard_homeowner_columns' AND NOT tgisinternal),
    (SELECT pg_get_functiondef('public.quotes_guard_homeowner_columns()'::regprocedure) LIKE '%gh-2519: the fee columns%'
         OR pg_get_functiondef('public.quotes_guard_homeowner_columns()'::regprocedure) LIKE '%fee_amount, fee_percentage, platform_fee_pct and platform_fee_basis can only%'));

  -- F: the claim owner against the fee columns (#2519 body: "the fee columns").
  BEGIN
    v := v || E'\nF0 CONTROL stranger UPDATE qb.fee_amount=0: ' || pg_temp.try_as('authenticated', stranger, format('UPDATE public.quotes SET fee_amount=0 WHERE id=%L', qb));
    v := v || E'\nF1 OWNER UPDATE qb.fee_amount=0: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET fee_amount=0 WHERE id=%L', qb));
    v := v || format(' -> fee_amount=%s', (SELECT fee_amount FROM quotes WHERE id = qb));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;
  BEGIN
    v := v || E'\nF2 OWNER UPDATE qb.platform_fee_pct=0 (the rate the platform charges): ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET platform_fee_pct=0 WHERE id=%L', qb));
    v := v || format(' -> platform_fee_pct=%s fee_amount=%s', (SELECT platform_fee_pct FROM quotes WHERE id = qb), (SELECT fee_amount FROM quotes WHERE id = qb));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;
  BEGIN
    v := v || E'\nF3 OWNER UPDATE qb.fee_percentage=0: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET fee_percentage=0 WHERE id=%L', qb));
    v := v || format(' -> fee_percentage=%s', (SELECT fee_percentage FROM quotes WHERE id = qb));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;
  BEGIN
    v := v || E'\nF4 OWNER UPDATE qb.platform_fee_basis=''other'': ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET platform_fee_basis=''other'' WHERE id=%L', qb));
    v := v || format(' -> platform_fee_basis=%s', (SELECT platform_fee_basis FROM quotes WHERE id = qb));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;
  BEGIN
    v := v || E'\nF5 OWNER UPDATE qb status=selected + platform_fee_pct=0 + fee_amount=0 in one statement: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''selected'', platform_fee_pct=0, fee_amount=0 WHERE id=%L', qb));
    v := v || format(' -> status=%s platform_fee_pct=%s fee_amount=%s', (SELECT status FROM quotes WHERE id = qb), (SELECT platform_fee_pct FROM quotes WHERE id = qb), (SELECT fee_amount FROM quotes WHERE id = qb));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- L: the legitimate writers (negative controls beside the F lines).
  BEGIN
    v := v || E'\nL1 LEGIT CONTRACTOR k2 change-bid payload on qb (total_price, fee_percentage, fee_amount, platform_fee_pct, platform_fee_basis, fee_accepted_at, scope, notes, updated_at): ' || pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET total_price=15500, fee_percentage=5, fee_amount=775, platform_fee_pct=5, platform_fee_basis=''bid_amount'', fee_accepted_at=now(), scope_summary=''gh2519 proof'', notes=''gh2519 proof'', updated_at=now() WHERE id=%L', qb));
    v := v || format(' -> total_price=%s fee_amount=%s', (SELECT total_price FROM quotes WHERE id = qb), (SELECT fee_amount FROM quotes WHERE id = qb));
    v := v || E'\nL2 LEGIT CONTRACTOR k2 re-sends the same fee values on qb: ' || pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET fee_percentage=fee_percentage, fee_amount=fee_amount, platform_fee_pct=platform_fee_pct, platform_fee_basis=platform_fee_basis, updated_at=now() WHERE id=%L', qb));
    v := v || E'\nK1 (residual, not closed here) CONTRACTOR k2 lowers own qb.platform_fee_pct to 4: ' || pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET platform_fee_pct=4 WHERE id=%L', qb));
    v := v || format(' -> platform_fee_pct=%s fee_amount=%s', (SELECT platform_fee_pct FROM quotes WHERE id = qb), (SELECT fee_amount FROM quotes WHERE id = qb));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;
  BEGIN
    UPDATE public.quotes SET claim_id = cs WHERE id = qb;           -- fixture (superuser): qb beside qs on cs
    UPDATE public.quotes SET contractor_id = k3 WHERE id IN (qs, qb); -- fixture: k3 has a payment method on file
    v := v || E'\nL3 LEGIT OWNER award: status=selected with the fee columns re-sent unchanged: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET fee_amount=fee_amount, fee_percentage=fee_percentage, platform_fee_pct=platform_fee_pct, platform_fee_basis=platform_fee_basis, status=''selected'' WHERE id=%L', qb));
    v := v || E'\nL4 LEGIT OWNER declines the other bid qs (status=declined): ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''declined'' WHERE id=%L', qs));
    v := v || E'\nL5 LEGIT OWNER stamps homeowner_signed_at on qb: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET homeowner_signed_at=now() WHERE id=%L', qb));
    v := v || format(' -> qb status=%s qs status=%s', (SELECT status FROM quotes WHERE id = qb), (SELECT status FROM quotes WHERE id = qs));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;
  BEGIN
    v := v || E'\nL6 LEGIT service_role UPDATE qb.platform_fee_pct=6: ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET platform_fee_pct=6 WHERE id=%L', qb));
    v := v || format(' -> platform_fee_pct=%s fee_amount=%s', (SELECT platform_fee_pct FROM quotes WHERE id = qb), (SELECT fee_amount FROM quotes WHERE id = qb));
    v := v || E'\nL7 LEGIT ADMIN UPDATE qb.platform_fee_pct=7 (admin email, as the admin pages do): ' || pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET platform_fee_pct=7 WHERE id=%L', qb), 'dustin@otterquote.com');
    v := v || format(' -> platform_fee_pct=%s', (SELECT platform_fee_pct FROM quotes WHERE id = qb));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;
  BEGIN
    UPDATE public.quotes SET claim_id = cs WHERE id = qb;
    UPDATE public.quotes SET contractor_id = k3 WHERE id IN (qs, qb);
    v := v || E'\nL8 LEGIT OWNER accept_bid(cs, qb) RPC (SECURITY DEFINER, untouched): ' || pg_temp.q_as('authenticated', o, format('SELECT ''quote='' || left(out_quote_id::text,8) || '' amount='' || out_amount || '' declined='' || out_declined_count FROM public.accept_bid(%L,%L)', cs, qb));
    v := v || format(' -> qb=%s qs=%s claim cs=%s fee_amount=%s', (SELECT status FROM quotes WHERE id = qb), (SELECT status FROM quotes WHERE id = qs), (SELECT status FROM claims WHERE id = cs), (SELECT fee_amount FROM quotes WHERE id = qb));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  RETURN v;
END $s$;

DO $proof$
BEGIN
  RAISE EXCEPTION E'GH2519_FEE_FORCED_ROLLBACK%', pg_temp.gh2519_fee_scenario();
END
$proof$;
