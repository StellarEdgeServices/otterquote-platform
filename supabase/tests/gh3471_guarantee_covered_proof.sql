-- gh-3471 coverage: assertions for one phase, run by gh3471_guarantee_covered_proof_run.sh on a THROWAWAY Postgres. Prints one row per check and a FAILING= summary.
-- Variable :phase is 'before' (column absent), 'after' (forward applied) or 'rollback' (forward then rollback).
\set ON_ERROR_STOP on
CREATE TEMP TABLE r (n int, check_name text, ok boolean);

INSERT INTO r SELECT 1, 'guarantee_covered column present = ' || (:'phase' = 'after'),
  (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='hover_orders' AND column_name='guarantee_covered' AND data_type='boolean' AND is_nullable='YES' AND column_default IS NULL)) = (:'phase' = 'after');
INSERT INTO r SELECT 2, 'hover_orders_guarantee_covered_chk present and validated = ' || (:'phase' = 'after'),
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conname='hover_orders_guarantee_covered_chk' AND convalidated)) = (:'phase' = 'after');
INSERT INTO r SELECT 3, 'the clock columns and hover_orders_guarantee_clock_chk are untouched',
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='hover_orders' AND column_name IN ('guarantee_started_at','guarantee_deadline_at')) = 2
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='hover_orders_guarantee_clock_chk' AND convalidated);
INSERT INTO r SELECT 4, 'NO platform_settings guarantee_excluded_states row (the list ships empty/unset)',
  NOT EXISTS (SELECT 1 FROM public.platform_settings WHERE key='guarantee_excluded_states');
INSERT INTO r SELECT 5, 'pre-existing rows kept (seeded 3)', (SELECT count(*) FROM public.hover_orders WHERE admin_notes LIKE 'seed%') = 3;
INSERT INTO r SELECT 6, 'RLS still on, policies unchanged (2)',
  (SELECT relrowsecurity FROM pg_class WHERE oid='public.hover_orders'::regclass)
  AND (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='hover_orders') = 2;

-- Behaviour of the CHECK (after only): each attempt runs in a savepoint-like DO block and records whether it was accepted.
CREATE TEMP TABLE w (n int, check_name text, expect_ok boolean, got_ok boolean);
DO $d$
DECLARE
  t timestamptz := '2026-11-09T12:00:00Z';
  ph text := current_setting('gh3471.phase');
  accepted boolean;
BEGIN
  IF ph <> 'after' THEN RETURN; END IF;
  -- 7 covered=true with a clock: accepted
  BEGIN INSERT INTO public.hover_orders (admin_notes, guarantee_started_at, guarantee_deadline_at, guarantee_covered) VALUES ('t7', t, t + interval '100 hours', true); accepted := true;
  EXCEPTION WHEN check_violation THEN accepted := false; END;
  INSERT INTO w VALUES (7, 'covered=true with a clock is accepted', true, accepted);
  -- 8 covered=false with a clock: accepted
  BEGIN INSERT INTO public.hover_orders (admin_notes, guarantee_started_at, guarantee_deadline_at, guarantee_covered) VALUES ('t8', t, t + interval '100 hours', false); accepted := true;
  EXCEPTION WHEN check_violation THEN accepted := false; END;
  INSERT INTO w VALUES (8, 'covered=false with a clock is accepted', true, accepted);
  -- 9 covered NULL with a clock: accepted (unknown)
  BEGIN INSERT INTO public.hover_orders (admin_notes, guarantee_started_at, guarantee_deadline_at) VALUES ('t9', t, t + interval '100 hours'); accepted := true;
  EXCEPTION WHEN check_violation THEN accepted := false; END;
  INSERT INTO w VALUES (9, 'covered NULL with a clock is accepted', true, accepted);
  -- 10 covered NULL, no clock (is_test / contractor): accepted
  BEGIN INSERT INTO public.hover_orders (admin_notes) VALUES ('t10'); accepted := true;
  EXCEPTION WHEN check_violation THEN accepted := false; END;
  INSERT INTO w VALUES (10, 'no clock, no coverage is accepted', true, accepted);
  -- 11 covered=true WITHOUT a clock: refused
  BEGIN INSERT INTO public.hover_orders (admin_notes, guarantee_covered) VALUES ('t11', true); accepted := true;
  EXCEPTION WHEN check_violation THEN accepted := false; END;
  INSERT INTO w VALUES (11, 'covered=true without a clock is REFUSED', false, accepted);
  -- 12 covered=false WITHOUT a clock: refused
  BEGIN INSERT INTO public.hover_orders (admin_notes, guarantee_covered) VALUES ('t12', false); accepted := true;
  EXCEPTION WHEN check_violation THEN accepted := false; END;
  INSERT INTO w VALUES (12, 'covered=false without a clock is REFUSED', false, accepted);
  -- 13 clearing the clock on a covered row: refused (the pair cannot drift apart later)
  BEGIN UPDATE public.hover_orders SET guarantee_started_at = NULL, guarantee_deadline_at = NULL WHERE admin_notes = 't7'; accepted := true;
  EXCEPTION WHEN check_violation THEN accepted := false; END;
  INSERT INTO w VALUES (13, 'clearing the clock under a coverage value is REFUSED', false, accepted);
  DELETE FROM public.hover_orders WHERE admin_notes LIKE 't%';
END $d$;
INSERT INTO r SELECT n, check_name, expect_ok = got_ok FROM w;

SELECT n || '|' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || check_name FROM r ORDER BY n;
SELECT 'FAILING=' || count(*) FILTER (WHERE NOT ok) || ' of ' || count(*) FROM r;
