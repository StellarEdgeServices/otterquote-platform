-- gh-2442 proof: contractor "retry payment" request path, SQL only
-- (supabase/migrations_drafts/gh2442_dunning_retry_request.sql; rollback beside it).
-- ONE batch. Its last statement is a deliberate RAISE EXCEPTION, so every fixture row and the migration's DDL roll
-- back whatever the client does; the findings are the exception text.
-- WHERE IT HAS BEEN RUN: the 2026-10-07 revision (cap, reason, rollback without the anon re-grant) was run on a
-- scratch Postgres built by supabase/tests/gh2442_replica_fixture.sql (the live table definition, policies and
-- grants copied from a read-only SELECT), NOT on production. The 2026-10-06 version of this file was run on
-- production (yeszghaspzwwstvsrioa) in this same rolled-back way. A production run of this version is the
-- applier's step, inside the apply window, and is not owed before review.
--   Run this file alone      : the NEGATIVE CONTROL. With the migration absent the function does not exist and
--                              anon still holds UPDATE/TRUNCATE/TRIGGER on payment_failures.
--   Forward mode             : replace the NULL between the @FWD@ markers with the body of the migration (BEGIN; and
--                              COMMIT; lines removed), dollar-quoted. The block prints the matrix twice: BEFORE the
--                              DDL (live state) and AFTER it.
--   Forward + rollback mode  : also replace the NULL between the @RBK@ markers with the body of the rollback file
--                              (BEGIN; and COMMIT; removed). The matrix prints a third time, ROLLED-BACK.
-- Roles are set the way PostgREST sets them (role + request.jwt.claims) and cleared after each call.
-- NO IDENTIFIERS ARE WRITTEN IN THIS FILE: contractors k1 and k2 (two is_test contractors with a login), the
-- homeowner (an is_test profile that is not a contractor) are looked up at run time and printed as 8-character
-- prefixes. payment_failures has no is_test column: its fixture rows belong to the is_test contractor k1 and carry
-- no quote or claim, and they exist only inside this batch.
-- Expected AFTER the migration (BEFORE differs only where marked):
--   F0   function exists, SECURITY DEFINER, search_path pinned;  anon cannot EXECUTE, authenticated can
--   G1-3 anon UPDATE / TRUNCATE / TRIGGER on the table:  BEFORE true  ->  AFTER false  ->  ROLLED-BACK still false
--   O1   owner, active row            requested; count 1; only the two retry columns changed (column-diff = none)
--   O2   owner again, same instant    already_requested; nothing written
--   O3   owner, request 16 min old    requested again; count 2 (the 15-minute window really expires)
--   O4   owner, warning_sent row      requested
--   C1   owner, 3rd request           requested; count 3; requests_remaining 0
--   C2   owner, same instant          already_requested (still true); nothing written
--   C3   owner, 16 min later          not_retryable / limit_reached; count stays 3; nothing written
--   C4   owner, 10 more tries, each 16 min later   every one limit_reached; count stays 3   (THE CAP)
--   N1   owner, resolved row          not_retryable / resolved (never "closed")
--   N1b  owner, resolved_at set but status still active   not_retryable / resolved
--   N2   owner, contractor_out row    not_retryable / closed
--   X1   another contractor           REJECTED 42501                X2  homeowner    REJECTED 42501
--   X3   anon                         REJECTED 42501 (permission)   X4  no login claim  REJECTED 42501
--   X5   unknown id                   REJECTED 42501                X6  NULL id        REJECTED 42501
--   D1   owner, direct table UPDATE of dunning_status / amount_cents / retry_requested_at / retry_request_count
--                                     0 rows (no policy)
--   D2   anon, direct table UPDATE    BEFORE 0 rows (RLS)  ->  AFTER REJECTED 42501  ->  ROLLED-BACK REJECTED 42501
--   R0   ROLLED-BACK: function gone, both columns gone, anon UPDATE/TRUNCATE/TRIGGER still false

CREATE FUNCTION pg_temp.as_call(p_role text, p_sub uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE v text; n int;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_role = 'anon' THEN json_build_object('role','anon')::text
     WHEN p_sub IS NULL THEN json_build_object('role', p_role)::text
     ELSE json_build_object('sub', p_sub, 'role', p_role, 'email', 'gh2442-proof@example.invalid')::text END, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    IF p_sql ~* '^\s*select' THEN EXECUTE p_sql INTO v; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; v := 'rows=' || n; END IF;
    EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
    RETURN COALESCE(v, 'NULL');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE'; PERFORM set_config('request.jwt.claims', '', true);
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 100);
  END;
END $f$;

-- everything in the row except the two retry columns, as one md5 (the "only those columns changed" test)
CREATE FUNCTION pg_temp.rowsig(p_id uuid) RETURNS text LANGUAGE sql AS
$$ SELECT md5((to_jsonb(pf) - 'retry_requested_at' - 'retry_request_count')::text) FROM public.payment_failures pf WHERE pf.id = p_id $$;

CREATE FUNCTION pg_temp.matrix(p_phase text) RETURNS text
LANGUAGE plpgsql AS $m$
DECLARE
  k1 uuid; k1u uuid; k2u uuid; ho uuid;
  fa uuid; fw uuid; fr uuid; fo uuid; fz uuid; i int; cnt int; agg text;
  out text := '';
  r text; sig0 text; sig1 text; ts0 timestamptz; ts1 timestamptz;
  has_fn boolean;
  call_tpl constant text := 'SELECT public.request_dunning_retry(%L)::text';
BEGIN
  SELECT c.id, c.user_id INTO k1, k1u FROM public.contractors c
   WHERE c.is_test AND c.user_id IS NOT NULL ORDER BY c.id LIMIT 1;
  SELECT c.user_id INTO k2u FROM public.contractors c
   WHERE c.is_test AND c.user_id IS NOT NULL AND c.user_id <> k1u ORDER BY c.id LIMIT 1;
  SELECT p.id INTO ho FROM public.profiles p
   WHERE p.is_test AND NOT EXISTS (SELECT 1 FROM public.contractors c WHERE c.user_id = p.id) ORDER BY p.id LIMIT 1;
  out := out || format('[%s] FIXTURES k1=%s k2login=%s homeowner=%s', p_phase, left(k1::text,8), left(k2u::text,8), left(ho::text,8)) || E'\n';
  IF k1 IS NULL OR k2u IS NULL OR ho IS NULL THEN RETURN out || '[' || p_phase || '] NO FIXTURE -> INCOMPLETE' || E'\n'; END IF;

  has_fn := to_regprocedure('public.request_dunning_retry(uuid)') IS NOT NULL;
  out := out || format('[%s] F0 function present=%s', p_phase, has_fn);
  IF has_fn THEN
    out := out || format(' secdef=%s config=%s anon_exec=%s authenticated_exec=%s',
      (SELECT prosecdef FROM pg_proc WHERE oid = 'public.request_dunning_retry(uuid)'::regprocedure),
      (SELECT proconfig FROM pg_proc WHERE oid = 'public.request_dunning_retry(uuid)'::regprocedure),
      has_function_privilege('anon','public.request_dunning_retry(uuid)','EXECUTE'),
      has_function_privilege('authenticated','public.request_dunning_retry(uuid)','EXECUTE'));
  END IF;
  out := out || E'\n' || format('[%s] G1-3 anon table privileges UPDATE=%s TRUNCATE=%s TRIGGER=%s | authenticated UPDATE=%s (unchanged by this change)', p_phase,
      has_table_privilege('anon','public.payment_failures','UPDATE'), has_table_privilege('anon','public.payment_failures','TRUNCATE'),
      has_table_privilege('anon','public.payment_failures','TRIGGER'), has_table_privilege('authenticated','public.payment_failures','UPDATE')) || E'\n';

  -- fixtures, owned by k1 (is_test), created by the superuser inside this batch
  INSERT INTO public.payment_failures (contractor_id, amount_cents, dunning_status) VALUES (k1, 12345, 'active')       RETURNING id INTO fa;
  INSERT INTO public.payment_failures (contractor_id, amount_cents, dunning_status) VALUES (k1, 12345, 'warning_sent') RETURNING id INTO fw;
  INSERT INTO public.payment_failures (contractor_id, amount_cents, dunning_status, resolved_at) VALUES (k1, 12345, 'resolved', now()) RETURNING id INTO fr;
  INSERT INTO public.payment_failures (contractor_id, amount_cents, dunning_status) VALUES (k1, 12345, 'contractor_out') RETURNING id INTO fo;
  INSERT INTO public.payment_failures (contractor_id, amount_cents, dunning_status, resolved_at) VALUES (k1, 12345, 'active', now()) RETURNING id INTO fz;

  IF NOT has_fn THEN
    out := out || format('[%s] O1 owner call: %s', p_phase, pg_temp.as_call('authenticated', k1u, format(call_tpl, fa))) || E'\n';
  ELSE
    sig0 := pg_temp.rowsig(fa);
    r := pg_temp.as_call('authenticated', k1u, format(call_tpl, fa));
    SELECT retry_requested_at INTO ts0 FROM public.payment_failures WHERE id = fa;
    sig1 := pg_temp.rowsig(fa);
    out := out || format('[%s] O1 owner, active row: %s | other columns unchanged=%s | retry_requested_at set=%s | count=%s', p_phase, r, sig0 = sig1, ts0 IS NOT NULL, (SELECT retry_request_count FROM public.payment_failures WHERE id = fa)) || E'\n';

    r := pg_temp.as_call('authenticated', k1u, format(call_tpl, fa));
    SELECT retry_requested_at INTO ts1 FROM public.payment_failures WHERE id = fa;
    out := out || format('[%s] O2 owner again inside 15 min: %s | retry_requested_at unchanged=%s | other columns unchanged=%s | count=%s', p_phase, r, ts0 = ts1, sig0 = pg_temp.rowsig(fa), (SELECT retry_request_count FROM public.payment_failures WHERE id = fa)) || E'\n';

    UPDATE public.payment_failures SET retry_requested_at = now() - interval '16 minutes' WHERE id = fa;
    SELECT retry_requested_at INTO ts0 FROM public.payment_failures WHERE id = fa;
    r := pg_temp.as_call('authenticated', k1u, format(call_tpl, fa));
    SELECT retry_requested_at INTO ts1 FROM public.payment_failures WHERE id = fa;
    out := out || format('[%s] O3 owner, request 16 min old: %s | retry_requested_at moved forward=%s | count=%s', p_phase, r, ts1 > ts0, (SELECT retry_request_count FROM public.payment_failures WHERE id = fa)) || E'\n';

    out := out || format('[%s] O4 owner, warning_sent row: %s', p_phase, pg_temp.as_call('authenticated', k1u, format(call_tpl, fw))) || E'\n';
    -- THE CAP, on the active row (it holds 2 requests after O1 and O3). Ageing the stored request by 16 minutes is
    -- done by the superuser here; a contractor cannot write that column (D1b).
    UPDATE public.payment_failures SET retry_requested_at = now() - interval '16 minutes' WHERE id = fa;
    r := pg_temp.as_call('authenticated', k1u, format(call_tpl, fa));
    out := out || format('[%s] C1 owner, 3rd request: %s | count=%s', p_phase, r, (SELECT retry_request_count FROM public.payment_failures WHERE id = fa)) || E'\n';
    SELECT retry_requested_at INTO ts0 FROM public.payment_failures WHERE id = fa;
    r := pg_temp.as_call('authenticated', k1u, format(call_tpl, fa));
    out := out || format('[%s] C2 owner, same instant: %s | count=%s', p_phase, r, (SELECT retry_request_count FROM public.payment_failures WHERE id = fa)) || E'\n';
    UPDATE public.payment_failures SET retry_requested_at = now() - interval '16 minutes' WHERE id = fa;
    SELECT retry_requested_at INTO ts0 FROM public.payment_failures WHERE id = fa;
    r := pg_temp.as_call('authenticated', k1u, format(call_tpl, fa));
    SELECT retry_requested_at, retry_request_count INTO ts1, cnt FROM public.payment_failures WHERE id = fa;
    out := out || format('[%s] C3 owner, 16 min after the 3rd: %s | count=%s | retry_requested_at unchanged=%s', p_phase, r, cnt, ts0 = ts1) || E'\n';
    agg := '';
    FOR i IN 1..10 LOOP
      UPDATE public.payment_failures SET retry_requested_at = retry_requested_at - interval '16 minutes' WHERE id = fa;
      r := pg_temp.as_call('authenticated', k1u, format(call_tpl, fa));
      agg := agg || CASE WHEN r::jsonb ->> 'reason' = 'limit_reached' AND r::jsonb ->> 'status' = 'not_retryable' THEN 'L' ELSE '!' END;
    END LOOP;
    out := out || format('[%s] C4 owner, 10 more tries each 16 min apart (L = limit_reached): %s | count=%s', p_phase, agg, (SELECT retry_request_count FROM public.payment_failures WHERE id = fa)) || E'\n';
    out := out || format('[%s] N1 owner, resolved row: %s | retry_requested_at still null=%s', p_phase, pg_temp.as_call('authenticated', k1u, format(call_tpl, fr)),
        (SELECT retry_requested_at IS NULL FROM public.payment_failures WHERE id = fr)) || E'\n';
    out := out || format('[%s] N2 owner, contractor_out row: %s | retry_requested_at still null=%s', p_phase, pg_temp.as_call('authenticated', k1u, format(call_tpl, fo)),
        (SELECT retry_requested_at IS NULL FROM public.payment_failures WHERE id = fo)) || E'\n';
    out := out || format('[%s] N1b owner, resolved_at set but status still active: %s | retry_requested_at still null=%s', p_phase, pg_temp.as_call('authenticated', k1u, format(call_tpl, fz)),
        (SELECT retry_requested_at IS NULL FROM public.payment_failures WHERE id = fz)) || E'\n';
    -- reset the active row so the rejection lines below start from a clean request state
    UPDATE public.payment_failures SET retry_requested_at = NULL, retry_request_count = 0 WHERE id = fa;
    out := out || format('[%s] X1 another contractor: %s', p_phase, pg_temp.as_call('authenticated', k2u, format(call_tpl, fa))) || E'\n';
    out := out || format('[%s] X2 homeowner: %s', p_phase, pg_temp.as_call('authenticated', ho, format(call_tpl, fa))) || E'\n';
    out := out || format('[%s] X3 anon: %s', p_phase, pg_temp.as_call('anon', NULL, format(call_tpl, fa))) || E'\n';
    out := out || format('[%s] X4 authenticated, no login claim: %s', p_phase, pg_temp.as_call('authenticated', NULL, format(call_tpl, fa))) || E'\n';
    out := out || format('[%s] X5 owner, unknown id: %s', p_phase, pg_temp.as_call('authenticated', k1u, format(call_tpl, gen_random_uuid()))) || E'\n';
    out := out || format('[%s] X6 owner, NULL id: %s', p_phase, pg_temp.as_call('authenticated', k1u, 'SELECT public.request_dunning_retry(NULL)::text')) || E'\n';
    out := out || format('[%s] X-none: after X1-X6 the active row still has retry_requested_at null=%s, count=%s and other columns unchanged=%s', p_phase,
        (SELECT retry_requested_at IS NULL FROM public.payment_failures WHERE id = fa), (SELECT retry_request_count FROM public.payment_failures WHERE id = fa), sig0 = pg_temp.rowsig(fa)) || E'\n';
  END IF;

  sig0 := pg_temp.rowsig(fa);
  out := out || format('[%s] D1 owner, direct table UPDATE of dunning_status/amount_cents: %s | row unchanged=%s', p_phase,
      pg_temp.as_call('authenticated', k1u, format('UPDATE public.payment_failures SET dunning_status=%L, amount_cents=1 WHERE id=%L', 'resolved', fa)), sig0 = pg_temp.rowsig(fa)) || E'\n';
  IF has_fn THEN
    out := out || format('[%s] D1b owner, direct table UPDATE of retry_requested_at and retry_request_count: %s | still null=%s | count=%s', p_phase,
      pg_temp.as_call('authenticated', k1u, format('UPDATE public.payment_failures SET retry_requested_at=now(), retry_request_count=-5 WHERE id=%L', fa)),
      (SELECT retry_requested_at IS NULL FROM public.payment_failures WHERE id = fa), (SELECT retry_request_count FROM public.payment_failures WHERE id = fa)) || E'\n';
  END IF;
  out := out || format('[%s] D2 anon, direct table UPDATE: %s | row unchanged=%s', p_phase,
      pg_temp.as_call('anon', NULL, format('UPDATE public.payment_failures SET amount_cents=1 WHERE id=%L', fa)), sig0 = pg_temp.rowsig(fa)) || E'\n';
  RETURN out;
END $m$;

DO $proof$
DECLARE
  v_fwd text := /*@FWD@*/ NULL /*@FWD@*/;
  v_rbk text := /*@RBK@*/ NULL /*@RBK@*/;
  n0 bigint; n1 bigint; out text := '';
BEGIN
  SELECT count(*) INTO n0 FROM public.payment_failures;
  out := out || pg_temp.matrix('BEFORE');
  IF v_fwd IS NOT NULL THEN
    EXECUTE v_fwd;
    out := out || pg_temp.matrix('AFTER');
    IF v_rbk IS NOT NULL THEN
      EXECUTE v_rbk;
      out := out || pg_temp.matrix('ROLLED-BACK');
      out := out || format('[ROLLED-BACK] R0 function count=%s | retry columns left=%s | anon UPDATE=%s TRUNCATE=%s TRIGGER=%s',
        (SELECT count(*) FROM pg_proc WHERE proname = 'request_dunning_retry'),
        (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_failures' AND column_name IN ('retry_requested_at', 'retry_request_count')),
        has_table_privilege('anon','public.payment_failures','UPDATE'), has_table_privilege('anon','public.payment_failures','TRUNCATE'),
        has_table_privilege('anon','public.payment_failures','TRIGGER')) || E'\n';
    END IF;
  END IF;
  SELECT count(*) INTO n1 FROM public.payment_failures;
  out := out || format('ROWS payment_failures before-run=%s inside-batch-end=%s (fixtures; the batch rolls back)', n0, n1);
  RAISE EXCEPTION E'\n%', out USING ERRCODE = 'P0U01';
END $proof$;
