-- gh-2620 proof: claims_enforce_payment_method_on_award() as SECURITY DEFINER, on production, in ONE statement.
-- Run against production (yeszghaspzwwstvsrioa). A single DO block whose last action is a deliberate
-- RAISE EXCEPTION, so the forward DDL and every fixture write roll back whatever the client does; the
-- findings are the exception text. The text between the $fwd$ markers is the body of
-- supabase/migrations_drafts/gh2620_claims_payment_guard_security_definer.sql without its header and
-- BEGIN/COMMIT lines (regenerate if that file changes).
-- Fixtures are looked up at run time (nothing hard-coded): an is_test homeowner's is_test claim in
-- 'bidding' that has a quote, an is_test contractor with has_payment_method = true (k_pm), and the quote's
-- own is_test contractor, which has none (k_no). Real rows are never addressed.
-- Phases (each attempt runs as role authenticated with the homeowner's JWT sub, in its own savepoint):
--   BEFORE  live function  : React-shape award to k_pm  -> expect REJECTED P0001 (the defect, the negative control)
--   FORWARD applied
--   AFTER   new function   : same award to k_pm        -> expect ACCEPTED, claim awarded
--                            award to k_no             -> expect REJECTED P0001 (guard still works)
--                            award with NULL contractor-> expect REJECTED P0001
--                            full React sequence (claim, winning quote, decline others) -> ACCEPTED
--                            accept_bid() RPC to k_pm  -> expect ACCEPTED (the bids.html path still works)
--                            homeowner still cannot SELECT contractors -> expect rows=0
--                            prosecdef, search_path, EXECUTE grants, body md5 unchanged

CREATE FUNCTION pg_temp.try_as(p_sub uuid, p_sql text, p_select boolean) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated', 'email', 'gh2620-proof@example.invalid')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 100);
  END;
END $f$;
DO $proof$
DECLARE
  v text := '';
  owner_id uuid; c uuid; q uuid; k_pm uuid; k_no uuid;
  fwd text := $fwd$
CREATE OR REPLACE FUNCTION public.claims_enforce_payment_method_on_award()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
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

REVOKE EXECUTE ON FUNCTION public.claims_enforce_payment_method_on_award() FROM PUBLIC, anon, authenticated;
$fwd$;
  md5_before text; md5_after text;
BEGIN
  SELECT cl.id, cl.user_id, qt.id, qt.contractor_id INTO c, owner_id, q, k_no
    FROM public.claims cl JOIN public.profiles p ON p.id = cl.user_id JOIN public.quotes qt ON qt.claim_id = cl.id
   WHERE cl.is_test AND p.is_test AND qt.is_test AND cl.status = 'bidding'
   ORDER BY cl.id LIMIT 1;
  SELECT id INTO k_pm FROM public.contractors WHERE is_test AND has_payment_method IS TRUE ORDER BY id LIMIT 1;
  v := v || E'\nFIXTURES ' || format('claim=%s status=%s is_test=%s owner_is_test=%s quote=%s is_test=%s | k_pm=%s is_test=%s has_pm=%s | k_no=%s is_test=%s has_pm=%s',
    left(c::text,8), (SELECT status FROM claims WHERE id=c), (SELECT is_test FROM claims WHERE id=c), (SELECT is_test FROM profiles WHERE id=owner_id),
    left(q::text,8), (SELECT is_test FROM quotes WHERE id=q),
    left(k_pm::text,8), (SELECT is_test FROM contractors WHERE id=k_pm), (SELECT has_payment_method FROM contractors WHERE id=k_pm),
    left(k_no::text,8), (SELECT is_test FROM contractors WHERE id=k_no), (SELECT has_payment_method FROM contractors WHERE id=k_no));
  IF c IS NULL OR k_pm IS NULL OR k_no IS NULL THEN RAISE EXCEPTION 'fixture lookup failed: %', v; END IF;

  SELECT md5(prosrc) INTO md5_before FROM pg_proc WHERE oid = 'public.claims_enforce_payment_method_on_award'::regproc;
  v := v || E'\nLIVE ' || (SELECT format('prosecdef=%s search_path=%s acl=%s body_md5=%s', prosecdef, proconfig::text, proacl::text, left(md5_before,8)) FROM pg_proc WHERE oid = 'public.claims_enforce_payment_method_on_award'::regproc);

  v := v || E'\nBEFORE-1 homeowner reads contractors row k_pm: ' || pg_temp.try_as(owner_id, format('SELECT 1 FROM public.contractors WHERE id=%L', k_pm), true);
  v := v || E'\nBEFORE-2 homeowner React award to k_pm (PM=true): ' || pg_temp.try_as(owner_id, format('UPDATE public.claims SET selected_contractor_id=%L, selected_bid_amount=1000, status=''awarded'' WHERE id=%L', k_pm, c), false);

  EXECUTE fwd;
  v := v || E'\nFORWARD applied';

  SELECT md5(prosrc) INTO md5_after FROM pg_proc WHERE oid = 'public.claims_enforce_payment_method_on_award'::regproc;
  v := v || E'\nNOW ' || (SELECT format('prosecdef=%s search_path=%s acl=%s body_md5=%s body_unchanged=%s', prosecdef, proconfig::text, proacl::text, left(md5_after,8), md5_before = md5_after) FROM pg_proc WHERE oid = 'public.claims_enforce_payment_method_on_award'::regproc);
  v := v || E'\nNOW-GRANTS ' || format('public=%s anon=%s authenticated=%s service_role=%s',
    has_function_privilege('public', 'public.claims_enforce_payment_method_on_award()', 'execute') ,
    has_function_privilege('anon', 'public.claims_enforce_payment_method_on_award()', 'execute'),
    has_function_privilege('authenticated', 'public.claims_enforce_payment_method_on_award()', 'execute'),
    has_function_privilege('service_role', 'public.claims_enforce_payment_method_on_award()', 'execute'));

  v := v || E'\nAFTER-1 homeowner reads contractors row k_pm (must stay rows=0): ' || pg_temp.try_as(owner_id, format('SELECT 1 FROM public.contractors WHERE id=%L', k_pm), true);
  BEGIN
    v := v || E'\nAFTER-2 homeowner React award to k_pm (PM=true): ' || pg_temp.try_as(owner_id, format('UPDATE public.claims SET selected_contractor_id=%L, selected_bid_amount=1000, status=''awarded'' WHERE id=%L', k_pm, c), false);
    v := v || format(' -> claim.status=%s', (SELECT status FROM claims WHERE id=c));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;
  BEGIN
    v := v || E'\nAFTER-3 NEGATIVE CONTROL homeowner React award to k_no (PM=false): ' || pg_temp.try_as(owner_id, format('UPDATE public.claims SET selected_contractor_id=%L, selected_bid_amount=1000, status=''awarded'' WHERE id=%L', k_no, c), false);
    v := v || format(' -> claim.status=%s', (SELECT status FROM claims WHERE id=c));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;
  BEGIN
    v := v || E'\nAFTER-4 NEGATIVE CONTROL homeowner award with selected_contractor_id NULL: ' || pg_temp.try_as(owner_id, format('UPDATE public.claims SET selected_contractor_id=NULL, status=''awarded'' WHERE id=%L', c), false);
    v := v || format(' -> claim.status=%s', (SELECT status FROM claims WHERE id=c));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- AFTER-5: the whole React sequence, with the quote moved to k_pm (superuser fixture write, rolled back).
  BEGIN
    UPDATE public.quotes SET contractor_id = k_pm WHERE id = q;
    v := v || E'\nAFTER-5a claim award:  ' || pg_temp.try_as(owner_id, format('UPDATE public.claims SET selected_contractor_id=%L, selected_bid_amount=1000, status=''awarded'' WHERE id=%L', k_pm, c), false);
    v := v || E'\nAFTER-5b winning quote selected: ' || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', q), false);
    v := v || E'\nAFTER-5c decline others: ' || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET status=''declined'' WHERE claim_id=%L AND id<>%L', c, q), false);
    v := v || format(' -> claim.status=%s quote.status=%s', (SELECT status FROM claims WHERE id=c), (SELECT status FROM quotes WHERE id=q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- AFTER-6: the bids.html path (accept_bid RPC) is unchanged.
  BEGIN
    UPDATE public.quotes SET contractor_id = k_pm WHERE id = q;
    v := v || E'\nAFTER-6 accept_bid() RPC as homeowner to k_pm: ' || pg_temp.try_as(owner_id, format('SELECT * FROM public.accept_bid(%L, %L)', c, q), false);
    v := v || format(' -> claim.status=%s quote.status=%s', (SELECT status FROM claims WHERE id=c), (SELECT status FROM quotes WHERE id=q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  v := v || E'\nEND-STATE claim.status=' || (SELECT status FROM claims WHERE id=c) || ' (inside the transaction, before the forced rollback)';
  RAISE EXCEPTION E'GH2620-PROOF\n%', v USING ERRCODE = 'P0U02';
END
$proof$;
