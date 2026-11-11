-- gh-3560 proof: public.renew_quote(uuid, text) (draft supabase/migrations_drafts/gh3560_renew_quote_rpc.sql).
--
-- RUN ONLY INSIDE A TRANSACTION THAT IS ROLLED BACK. Nothing here may persist. The function is created in the SAME transaction
-- (it is a draft and is not applied to production). To run:
--   1. BEGIN;
--   2. the draft's statements with its own BEGIN; and COMMIT; lines removed:
--        sed '/^BEGIN;$/d;/^COMMIT;$/d' supabase/migrations_drafts/gh3560_renew_quote_rpc.sql
--   3. this file from the line "DO $assert$" to the end, then ROLLBACK;
-- (The statement at the end of this file puts the report in the setting gh3560.out and SELECTs it before the ROLLBACK. A client
-- that returns only the last statement's result can instead end with a DO block that RAISEs EXCEPTION with that setting; the
-- error aborts the transaction, which is a rollback too.)
--
-- Cases: D0/D1 controls; R1 renew, R2 reopen (own withdrawal, cancelled_at NULL); R3 other contractor; R4 active; R5 mode mismatch; R6 mode;
-- R7 anon; R8 selected; R9 declined on awarded claim; R10 D-170 contractor_can_bid gate (stubbed); R11 reopen with cancelled_at set; G grants.
-- Rows used (all is_test, production, read by SELECT 2026-11-09): contractor A 5e76adc9 (user 901008b8) with quote e6261cb3 on an
-- active claim; contractor B 848798cc (user ce69bf9d) with quote ca91add4; contractor C 2bc792be (user 92d669a8) with the selected
-- quote 6fd064f1 on an awarded claim; contractor D bb07fc40 (user 189b85ad) with the declined, cancelled quote 0a334300 on an
-- awarded claim. The fixture step moves A's quote to expired, B's to cancelled and C's to expired as the table owner (the guard
-- trigger only checks client roles), inside the transaction.
-- Roles are set the way PostgREST sets them: SET LOCAL ROLE + request.jwt.claims. Each case runs in its own sub-transaction and is undone.
DO $assert$
BEGIN
  IF to_regprocedure('public.renew_quote(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'gh3560 proof: public.renew_quote(uuid, text) does not exist; create it from the draft in this transaction first';
  END IF;
END
$assert$;

CREATE FUNCTION pg_temp.try_as(r text, uid uuid, q text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN uid IS NULL THEN '{"role":"' || r || '"}' ELSE json_build_object('sub', uid, 'role', r)::text END, true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(r);
  EXECUTE q;
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  RETURN 'OK rows=' || n;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RETURN 'REFUSED ' || SQLSTATE || ' ' || SQLERRM;
END $f$;

-- keys whose value differs between two row images, with the new value
CREATE FUNCTION pg_temp.diff(a jsonb, b jsonb) RETURNS text LANGUAGE sql AS $f$
  SELECT COALESCE(string_agg(n.key || '=' || COALESCE(n.value::text, 'null'), ', ' ORDER BY n.key), '(no column changed)')
    FROM jsonb_each(b) n JOIN jsonb_each(a) o ON o.key = n.key WHERE n.value IS DISTINCT FROM o.value
$f$;

-- fixtures (table owner; rolled back with the transaction)
UPDATE public.quotes SET bid_status = 'expired',   expired_at = now() - interval '1 day', expires_at = now() - interval '1 day' WHERE id = 'e6261cb3-1132-4ce4-bb31-4231f3a801c7';
UPDATE public.quotes SET bid_status = 'cancelled'                                                                                WHERE id = 'ca91add4-1019-49d5-9682-2e8ebe1e0c3c';
UPDATE public.quotes SET bid_status = 'expired',   expired_at = now() - interval '1 day'                                         WHERE id = '6fd064f1-4d3f-4fda-af82-da9363a6812f';

DO $proof$
DECLARE
  ua uuid := '901008b8-dc5d-4af4-ae6c-06f6305ed72f'; qa uuid := 'e6261cb3-1132-4ce4-bb31-4231f3a801c7';
  ub uuid := 'ce69bf9d-6874-4fcd-9fa1-ef18e7ebf72c'; qb uuid := 'ca91add4-1019-49d5-9682-2e8ebe1e0c3c';
  uc uuid := '92d669a8-c02a-42c1-9f52-53b7efd06ddf'; qc uuid := '6fd064f1-4d3f-4fda-af82-da9363a6812f';
  ud uuid := '189b85ad-0ab0-4e54-9083-c51c3ef42a1d'; qd uuid := '0a334300-2a4a-4ba6-ac77-efea0fa73179';
  v text := ''; before_row jsonb; after_row jsonb; ok boolean;
  nowts timestamptz := now();
BEGIN
  v := 'BASELINE A qa: ' || (SELECT format('status=%s bid_status=%s expired_at set=%s', status, bid_status, expired_at IS NOT NULL) FROM public.quotes WHERE id = qa)
    || E'\nBASELINE B qb: ' || (SELECT format('status=%s bid_status=%s cancelled_at set=%s', status, bid_status, cancelled_at IS NOT NULL) FROM public.quotes WHERE id = qb)
    || E'\nBASELINE C qc: ' || (SELECT format('status=%s bid_status=%s', status, bid_status) FROM public.quotes WHERE id = qc)
    || E'\nBASELINE D qd: ' || (SELECT format('status=%s bid_status=%s claim=%s', q.status, q.bid_status, c.status) FROM public.quotes q JOIN public.claims c ON c.id = q.claim_id WHERE q.id = qd);

  -- D0 control: the refusal the brief describes. A contractor's direct UPDATE of bid_status is refused by the guard.
  BEGIN
    v := v || E'\nD0 CONTROL contractor A direct UPDATE qa SET bid_status=''active'', expired_at=null, expires_at=now()+14d: '
      || pg_temp.try_as('authenticated', ua, format('UPDATE public.quotes SET bid_status = ''active'', expired_at = NULL, expires_at = now() + interval ''14 days'' WHERE id = %L', qa))
      || ' -> bid_status still ' || (SELECT bid_status FROM public.quotes WHERE id = qa);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- D1 control: the bid-form columns still go through the normal UPDATE (unchanged by this PR)
  BEGIN
    v := v || E'\nD1 CONTROL contractor A direct UPDATE qa SET notes (a bid-form column): '
      || pg_temp.try_as('authenticated', ua, format('UPDATE public.quotes SET notes = ''gh3560 control'' WHERE id = %L', qa));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- R1 renew, own expired quote
  BEGIN
    before_row := (SELECT to_jsonb(q) FROM public.quotes q WHERE id = qa);
    v := v || E'\nR1 contractor A renew_quote(qa, ''renew''): ' || pg_temp.try_as('authenticated', ua, format('SELECT public.renew_quote(%L, ''renew'')', qa));
    after_row := (SELECT to_jsonb(q) FROM public.quotes q WHERE id = qa);
    v := v || E'\n   columns changed: ' || regexp_replace(pg_temp.diff(before_row, after_row), '"[0-9T:.+\-]{20,}"', '<ts>', 'g');
    v := v || format(E'\n   bid_status=%s expired_at=%s expires_at within 14d window (13d23h..14d0h5m from txn start)=%s updated_at>=txn start=%s status unchanged=%s total_price/fee unchanged=%s',
        after_row->>'bid_status', COALESCE(after_row->>'expired_at', 'null'),
        ((after_row->>'expires_at')::timestamptz BETWEEN nowts + interval '13 days 23 hours' AND nowts + interval '14 days 5 minutes'),
        ((after_row->>'updated_at')::timestamptz >= nowts),
        (after_row->>'status') = (before_row->>'status'),
        (after_row->>'total_price') IS NOT DISTINCT FROM (before_row->>'total_price') AND (after_row->>'fee_amount') IS NOT DISTINCT FROM (before_row->>'fee_amount')
          AND (after_row->>'platform_fee_pct') IS NOT DISTINCT FROM (before_row->>'platform_fee_pct'));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- R2 reopen, own cancelled quote
  BEGIN
    before_row := (SELECT to_jsonb(q) FROM public.quotes q WHERE id = qb);
    v := v || E'\nR2 contractor B renew_quote(qb, ''reopen'') (own withdrawal, cancelled_at NULL): ' || pg_temp.try_as('authenticated', ub, format('SELECT public.renew_quote(%L, ''reopen'')', qb));
    after_row := (SELECT to_jsonb(q) FROM public.quotes q WHERE id = qb);
    v := v || E'\n   columns changed: ' || regexp_replace(pg_temp.diff(before_row, after_row), '"[0-9T:.+\-]{20,}"', '<ts>', 'g');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- R3 another contractor's quote
  BEGIN
    v := v || E'\nR3 contractor B renew_quote(qa, ''renew'') (A''s quote): ' || pg_temp.try_as('authenticated', ub, format('SELECT public.renew_quote(%L, ''renew'')', qa))
      || ' -> qa bid_status still ' || (SELECT bid_status FROM public.quotes WHERE id = qa);
    v := v || E'\nR3b contractor A renew_quote(qb, ''reopen'') (B''s quote): ' || pg_temp.try_as('authenticated', ua, format('SELECT public.renew_quote(%L, ''reopen'')', qb))
      || ' -> qb bid_status still ' || (SELECT bid_status FROM public.quotes WHERE id = qb);
    v := v || E'\nR3c contractor A renew_quote(random uuid) (no such quote): ' || pg_temp.try_as('authenticated', ua, 'SELECT public.renew_quote(gen_random_uuid(), ''renew'')');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- R4 an active quote
  BEGIN
    UPDATE public.quotes SET bid_status = 'active', expired_at = NULL WHERE id = qa;
    v := v || E'\nR4 contractor A renew_quote(qa, ''renew'') on an ACTIVE quote: ' || pg_temp.try_as('authenticated', ua, format('SELECT public.renew_quote(%L, ''renew'')', qa))
      || ' / ''reopen'': ' || pg_temp.try_as('authenticated', ua, format('SELECT public.renew_quote(%L, ''reopen'')', qa));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- R5 mode mismatch
  BEGIN
    v := v || E'\nR5 contractor A ''reopen'' on EXPIRED qa: ' || pg_temp.try_as('authenticated', ua, format('SELECT public.renew_quote(%L, ''reopen'')', qa))
      || E'\nR5b contractor B ''renew'' on CANCELLED qb: ' || pg_temp.try_as('authenticated', ub, format('SELECT public.renew_quote(%L, ''renew'')', qb));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- R6 unknown / null mode
  BEGIN
    v := v || E'\nR6 contractor A mode ''foo'': ' || pg_temp.try_as('authenticated', ua, format('SELECT public.renew_quote(%L, ''foo'')', qa))
      || E'\nR6b contractor A mode NULL: ' || pg_temp.try_as('authenticated', ua, format('SELECT public.renew_quote(%L, NULL)', qa));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- R7 anon
  BEGIN
    v := v || E'\nR7 anon renew_quote(qa, ''renew''): ' || pg_temp.try_as('anon', NULL, format('SELECT public.renew_quote(%L, ''renew'')', qa))
      || ' -> qa bid_status still ' || (SELECT bid_status FROM public.quotes WHERE id = qa);
    v := v || E'\nR7b authenticated role with no sub in the JWT (auth.uid() NULL): ' || pg_temp.try_as('authenticated', NULL, format('SELECT public.renew_quote(%L, ''renew'')', qa));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- R8 the contractor's own selected quote on an awarded claim (its bid_status moved to expired by the fixture)
  BEGIN
    v := v || E'\nR8 contractor C renew_quote(qc, ''renew'') on its SELECTED quote (claim awarded): ' || pg_temp.try_as('authenticated', uc, format('SELECT public.renew_quote(%L, ''renew'')', qc))
      || ' -> qc bid_status still ' || (SELECT bid_status FROM public.quotes WHERE id = qc);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- R9 a declined, cancelled quote on an awarded claim
  BEGIN
    v := v || E'\nR9 contractor D renew_quote(qd, ''reopen'') on its DECLINED quote (claim awarded): ' || pg_temp.try_as('authenticated', ud, format('SELECT public.renew_quote(%L, ''reopen'')', qd))
      || ' -> qd bid_status still ' || (SELECT bid_status FROM public.quotes WHERE id = qd);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;

  -- R10 D-170 eligibility (review B2). A suspended or COI-lapsed fixture cannot be built (enforce_contractor_privileged_columns refuses
  -- the change even to the table owner), so the gate is proved by replacing contractor_can_bid() INSIDE this sub-transaction with a
  -- stub that returns false for contractor A only; the replacement is undone with the sub-transaction.
  BEGIN
    v := v || format(E'\nR10 baseline: real contractor_can_bid(A)=%s (B)=%s', public.contractor_can_bid('5e76adc9-8bd9-4ab6-a8c6-6a083f70d102'), public.contractor_can_bid('848798cc-217c-44a5-83f3-c82b3c602452'));
    EXECUTE $stub$CREATE OR REPLACE FUNCTION public.contractor_can_bid(p_contractor_id uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
                   AS $b$ SELECT p_contractor_id <> '5e76adc9-8bd9-4ab6-a8c6-6a083f70d102'::uuid $b$$stub$;
    v := v || E'\nR10a STUBBED ineligible contractor A renew_quote(qa, ''renew''): ' || pg_temp.try_as('authenticated', ua, format('SELECT public.renew_quote(%L, ''renew'')', qa))
      || ' -> qa bid_status still ' || (SELECT bid_status FROM public.quotes WHERE id = qa);
    v := v || E'\nR10b same stub, eligible contractor B renew_quote(qb, ''reopen''): ' || pg_temp.try_as('authenticated', ub, format('SELECT public.renew_quote(%L, ''reopen'')', qb));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  v := v || E'\nR10c after undo, contractor_can_bid prosrc is the production body again: ' || (SELECT (prosrc LIKE '%coi_expires_at > CURRENT_DATE%')::text FROM pg_proc WHERE oid = 'public.contractor_can_bid(uuid)'::regprocedure);

  -- R11 reopen of a bid removed by the platform / switch-contractor (cancelled_at set). R2 above is the contractor's own withdrawal
  -- (cancelled_at NULL) and succeeds.
  BEGIN
    UPDATE public.quotes SET cancelled_at = now(), cancellation_reason = 'homeowner_switched_contractor' WHERE id = qb;
    v := v || E'\nR11 contractor B ''reopen'' on qb with cancelled_at set: ' || pg_temp.try_as('authenticated', ub, format('SELECT public.renew_quote(%L, ''reopen'')', qb))
      || ' -> qb bid_status still ' || (SELECT bid_status FROM public.quotes WHERE id = qb);
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL; END;
  v := v || E'\nR11b qb cancelled_at is NULL again after undo: ' || (SELECT (cancelled_at IS NULL)::text FROM public.quotes WHERE id = qb);

  -- G grants
  v := v || E'\nG1 EXECUTE: anon=' || has_function_privilege('anon', 'public.renew_quote(uuid,text)', 'EXECUTE')
    || ' authenticated=' || has_function_privilege('authenticated', 'public.renew_quote(uuid,text)', 'EXECUTE')
    || ' PUBLIC proacl=' || (SELECT proacl::text FROM pg_proc WHERE oid = 'public.renew_quote(uuid,text)'::regprocedure)
    || E'\nG2 prosecdef=' || (SELECT prosecdef FROM pg_proc WHERE oid = 'public.renew_quote(uuid,text)'::regprocedure)
    || ' proconfig=' || (SELECT proconfig::text FROM pg_proc WHERE oid = 'public.renew_quote(uuid,text)'::regprocedure);

  PERFORM set_config('gh3560.out', v, true);
END
$proof$;

SELECT current_setting('gh3560.out');
-- then: ROLLBACK;
