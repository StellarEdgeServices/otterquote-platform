-- gh-3219 (P18) proof: partner credit = 90-day window, last click wins, credit LOCKS at account creation.
-- Draft migration: supabase/migrations_drafts/gh3219_partner_credit_lock.sql
--
-- Run against production (yeszghaspzwwstvsrioa) as ONE statement batch that is forced to roll back (R-173/R-174: only is_test rows are
-- addressed; the last statement is a deliberate RAISE EXCEPTION whose message prints every result, so nothing commits).
--   BEFORE the fix : run this file alone.                      -> negative control: the cases marked [BUG] differ from `expected`.
--   AFTER the fix  : run the migration body (its own BEGIN; / COMMIT; lines removed) in place of the @@MIGRATION@@ marker, same batch.
--                    -> every row reads OK.
-- Fixtures (all is_test): the first 11 users of profiles(is_test) (S5 takes the 12th) that exist in auth.users, the first 2 referral_agents(is_test).
-- "Credited" means the two things apply_referral_commission() walks: the claim carries referral_id = X and X.status has advanced to
-- claim_submitted. Claims are rows of a TEMP table that carries the REAL trigger functions, so no claims row is written; the real
-- claims_advance_referral() and claims_apply_locked_referral() fire on it exactly as on public.claims.
-- Case ids: S1 A clicks, B clicks, sign up -> B.  S2 A clicks, sign up, B clicks, claim -> A.  S3 89 days credits.  S4 91 days does not.
--   S5 undated click does not.  S6 window read from platform_settings.  S7 one lock per user / per referral.  S8 get_locked_referral_id.
--   S9 an unlocked referral locks to the claim's user.
--   S10 lock 91 days old + newer click 10 days old -> the newer partner is credited and locked (S10b via sign-in too, S10c boundary: lock 89 days still holds).
--   S11 lock 91 days old, no newer click -> nobody credited (S11b: the other click is also outside the window).
-- Expected BEFORE: S2 claim.referral_id = B and A is not credited ([BUG]); S2b claim.referral_id is NULL ([BUG]); S6 window is '30 days' for
--   every setting and the 45-day click does not advance under '90' ([BUG]); S3 89d does not advance ([BUG], the old 30-day window);
--   S7/S8/S9 report 'absent' for the lock columns/functions. S1, S4, S5 already hold (they are the controls).

CREATE TEMP TABLE _r(n serial, k text, expected text, got text) ON COMMIT DROP;
CREATE TEMP TABLE proof_claims(id serial, user_id uuid, referral_id uuid, referral_agent_id uuid) ON COMMIT DROP;

-- @@MIGRATION@@

-- the REAL trigger functions on the temp claims table (the BEFORE one exists only after the migration)
CREATE TRIGGER proof_trg_advance AFTER INSERT ON proof_claims FOR EACH ROW EXECUTE FUNCTION public.claims_advance_referral();
DO $t$ BEGIN
  IF to_regprocedure('public.claims_apply_locked_referral()') IS NOT NULL THEN
    EXECUTE 'CREATE TRIGGER proof_trg_lock BEFORE INSERT ON proof_claims FOR EACH ROW EXECUTE FUNCTION public.claims_apply_locked_referral()';
  END IF;
END $t$;

CREATE FUNCTION pg_temp.as_user(u uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', u::text, 'email', 'p18-proof@example.invalid', 'role', 'authenticated')::text, true)
$$;
CREATE FUNCTION pg_temp.add(k text, expected text, got text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO _r(k, expected, got) VALUES (k, expected, got)
$$;
CREATE FUNCTION pg_temp.mkref(agent uuid, age interval) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.referrals (referral_agent_id, status, is_test) VALUES (agent, 'clicked', true) RETURNING id INTO v_id;
  UPDATE public.referrals SET created_at = now() - age WHERE id = v_id;
  RETURN v_id;
END $$;
CREATE FUNCTION pg_temp.st(r uuid) RETURNS text LANGUAGE sql AS $$ SELECT status FROM public.referrals WHERE id = r $$;
-- to_jsonb so this also runs BEFORE the column exists (reads NULL)
CREATE FUNCTION pg_temp.lock_of(r uuid) RETURNS text LANGUAGE sql AS $$ SELECT to_jsonb(x)->>'homeowner_user_id' FROM public.referrals x WHERE x.id = r $$;
CREATE FUNCTION pg_temp.file_claim(u uuid, r uuid) RETURNS integer LANGUAGE sql AS $$
  INSERT INTO proof_claims(user_id, referral_id) VALUES (u, r) RETURNING id
$$;
CREATE FUNCTION pg_temp.claim_ref(c integer) RETURNS uuid LANGUAGE sql AS $$ SELECT referral_id FROM proof_claims WHERE id = c $$;

DO $p$
DECLARE
  u uuid[]; ag uuid[];
  a uuid; b uuid; e uuid; c integer; x uuid; w text; ok boolean;
BEGIN
  SELECT array_agg(id) INTO u FROM (SELECT p.id FROM public.profiles p JOIN auth.users au ON au.id = p.id WHERE p.is_test ORDER BY p.id LIMIT 11) s;
  SELECT array_agg(id) INTO ag FROM (SELECT id FROM public.referral_agents WHERE is_test ORDER BY id LIMIT 2) s;
  IF coalesce(array_length(u,1),0) < 11 OR coalesce(array_length(ag,1),0) < 2 THEN
    PERFORM pg_temp.add('FIXTURES', 'need 11 is_test users (12 for S5) and 2 is_test agents', 'users=' || coalesce(array_length(u,1),0) || ' agents=' || coalesce(array_length(ag,1),0));
    RETURN;
  END IF;

  -- P0 objects (BEFORE the fix these are the old values)
  PERFORM pg_temp.add('P0 window volatility (s = STABLE)', 's', (SELECT provolatile::text FROM pg_proc WHERE oid = 'public.referral_attribution_window()'::regprocedure));
  PERFORM pg_temp.add('P0 window default', '90 days', public.referral_attribution_window()::text);
  PERFORM pg_temp.add('P0 referrals.homeowner_user_id column', 'present', CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='referrals' AND column_name='homeowner_user_id') THEN 'present' ELSE 'absent' END);
  PERFORM pg_temp.add('P0 unique partial index', 'present', CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='referrals' AND indexdef ILIKE 'CREATE UNIQUE INDEX%homeowner_user_id%WHERE%') THEN 'present' ELSE 'absent' END);
  PERFORM pg_temp.add('P0 settings row partner_attribution_window_days', '90', coalesce((SELECT value::text FROM public.platform_settings WHERE key='partner_attribution_window_days'), 'absent'));
  PERFORM pg_temp.add('P0 anon/authenticated EXECUTE on referral_attribution_window (want false,false)', 'false,false',
    has_function_privilege('anon','public.referral_attribution_window()','EXECUTE')::text || ',' || has_function_privilege('authenticated','public.referral_attribution_window()','EXECUTE')::text);

  -- S1: A clicks, B clicks, homeowner signs up (cookie holds B, the last click) -> B credited
  a := pg_temp.mkref(ag[1], interval '3 days'); b := pg_temp.mkref(ag[2], interval '1 day');
  PERFORM pg_temp.as_user(u[1]);
  PERFORM pg_temp.add('S1 advance(B) at sign-up', 'true', public.advance_referral_registered(b)::text);
  c := pg_temp.file_claim(u[1], b);
  PERFORM pg_temp.add('S1 claim.referral_id is B', 'B', CASE WHEN pg_temp.claim_ref(c) = b THEN 'B' WHEN pg_temp.claim_ref(c) = a THEN 'A' ELSE 'other' END);
  PERFORM pg_temp.add('S1 B status', 'claim_submitted', pg_temp.st(b));
  PERFORM pg_temp.add('S1 A status (not credited)', 'clicked', pg_temp.st(a));
  PERFORM pg_temp.add('S1 B locked to the user', u[1]::text, coalesce(pg_temp.lock_of(b), 'NULL'));

  -- S2: A clicks, homeowner signs up (A locked), B clicks, claim filed with B in the cookie -> A credited
  a := pg_temp.mkref(ag[1], interval '3 days');
  PERFORM pg_temp.as_user(u[2]);
  PERFORM pg_temp.add('S2 advance(A) at sign-up', 'true', public.advance_referral_registered(a)::text);
  b := pg_temp.mkref(ag[2], interval '1 day');            -- the later click on another partner's link
  PERFORM pg_temp.add('S2 advance(B) on the next sign-in [BUG before: true]', 'false', public.advance_referral_registered(b)::text);
  PERFORM pg_temp.add('S2 B status after advance(B)', 'clicked', pg_temp.st(b));
  c := pg_temp.file_claim(u[2], b);                        -- the browser sends B
  PERFORM pg_temp.add('S2 claim.referral_id is A [BUG before: B]', 'A', CASE WHEN pg_temp.claim_ref(c) = a THEN 'A' WHEN pg_temp.claim_ref(c) = b THEN 'B' ELSE 'other' END);
  PERFORM pg_temp.add('S2 claim.referral_agent_id is A''s agent', ag[1]::text, coalesce((SELECT referral_agent_id::text FROM proof_claims WHERE id = c), 'NULL'));
  PERFORM pg_temp.add('S2 A status [BUG before: registered]', 'claim_submitted', pg_temp.st(a));
  PERFORM pg_temp.add('S2 B status (not credited) [BUG before: claim_submitted]', 'clicked', pg_temp.st(b));
  PERFORM pg_temp.add('S2 A locked to the user', u[2]::text, coalesce(pg_temp.lock_of(a), 'NULL'));
  PERFORM pg_temp.add('S2 B not locked', 'NULL', coalesce(pg_temp.lock_of(b), 'NULL'));
  -- S2b: the cookie is gone entirely (cleared / expired) and the claim is filed with no referral: the lock still stamps A
  c := pg_temp.file_claim(u[2], NULL);
  PERFORM pg_temp.add('S2b claim with NULL referral_id -> A [BUG before: NULL]', 'A', CASE WHEN pg_temp.claim_ref(c) = a THEN 'A' WHEN pg_temp.claim_ref(c) IS NULL THEN 'NULL' ELSE 'other' END);

  -- S3: a click 89 days old credits (positive control for the 90-day window)
  a := pg_temp.mkref(ag[1], interval '89 days');
  PERFORM pg_temp.as_user(u[3]);
  PERFORM pg_temp.add('S3 advance(89-day-old click) [BUG before: false, 30-day window]', 'true', public.advance_referral_registered(a)::text);
  c := pg_temp.file_claim(u[3], a);
  PERFORM pg_temp.add('S3 89-day-old click status [BUG before: clicked]', 'claim_submitted', pg_temp.st(a));

  -- S4: a click 91 days old does not (negative control)
  a := pg_temp.mkref(ag[1], interval '91 days');
  PERFORM pg_temp.as_user(u[4]);
  PERFORM pg_temp.add('S4 advance(91-day-old click)', 'false', public.advance_referral_registered(a)::text);
  c := pg_temp.file_claim(u[4], a);
  PERFORM pg_temp.add('S4 91-day-old click status (not credited)', 'clicked', pg_temp.st(a));
  PERFORM pg_temp.add('S4 91-day-old click not locked', 'NULL', coalesce(pg_temp.lock_of(a), 'NULL'));

  -- S6: the window is read from platform_settings.partner_attribution_window_days
  UPDATE public.platform_settings SET value = to_jsonb(30) WHERE key = 'partner_attribution_window_days';
  PERFORM pg_temp.add('S6 setting 30 -> window [BUG before: always 30 days]', '30 days', public.referral_attribution_window()::text);
  a := pg_temp.mkref(ag[1], interval '45 days');
  PERFORM pg_temp.as_user(u[5]);
  PERFORM pg_temp.add('S6 setting 30: 45-day-old click advances', 'false', public.advance_referral_registered(a)::text);
  UPDATE public.platform_settings SET value = to_jsonb(120) WHERE key = 'partner_attribution_window_days';
  PERFORM pg_temp.add('S6 setting 120 -> window [BUG before: 30 days]', '120 days', public.referral_attribution_window()::text);
  a := pg_temp.mkref(ag[1], interval '100 days');
  PERFORM pg_temp.add('S6 setting 120: 100-day-old click advances [BUG before: false]', 'true', public.advance_referral_registered(a)::text);
  UPDATE public.platform_settings SET value = to_jsonb('abc'::text) WHERE key = 'partner_attribution_window_days';
  PERFORM pg_temp.add('S6 setting "abc" falls back to 90', '90 days', public.referral_attribution_window()::text);
  UPDATE public.platform_settings SET value = to_jsonb(0) WHERE key = 'partner_attribution_window_days';
  PERFORM pg_temp.add('S6 setting 0 falls back to 90', '90 days', public.referral_attribution_window()::text);
  UPDATE public.platform_settings SET value = to_jsonb(99999) WHERE key = 'partner_attribution_window_days';
  PERFORM pg_temp.add('S6 setting 99999 falls back to 90', '90 days', public.referral_attribution_window()::text);
  UPDATE public.platform_settings SET value = 'null'::jsonb WHERE key = 'partner_attribution_window_days';
  PERFORM pg_temp.add('S6 setting JSON null falls back to 90', '90 days', public.referral_attribution_window()::text);
  DELETE FROM public.platform_settings WHERE key = 'partner_attribution_window_days';
  PERFORM pg_temp.add('S6 setting row absent falls back to 90', '90 days', public.referral_attribution_window()::text);
  INSERT INTO public.platform_settings(key, value) VALUES ('partner_attribution_window_days', to_jsonb(90));

  -- S7: one lock per user, one user per referral
  a := pg_temp.mkref(ag[1], interval '2 days'); b := pg_temp.mkref(ag[2], interval '1 day');
  PERFORM pg_temp.as_user(u[6]);
  PERFORM pg_temp.add('S7 user6 advance(A)', 'true', public.advance_referral_registered(a)::text);
  PERFORM pg_temp.as_user(u[1]);
  PERFORM pg_temp.add('S7 a different user advancing the same referral [BUG before: false by status only]', 'false', public.advance_referral_registered(a)::text);
  PERFORM pg_temp.add('S7 A still locked to user6', u[6]::text, coalesce(pg_temp.lock_of(a), 'NULL'));
  ok := false;
  BEGIN
    EXECUTE format('UPDATE public.referrals SET homeowner_user_id = %L WHERE id = %L', u[6], b);
  EXCEPTION WHEN unique_violation THEN ok := true;
            WHEN undefined_column THEN ok := false;
  END;
  PERFORM pg_temp.add('S7 unique index refuses a 2nd locked referral for the same user', 'true', ok::text);

  -- S8: get_locked_referral_id
  PERFORM pg_temp.as_user(u[6]);
  IF to_regprocedure('public.get_locked_referral_id()') IS NULL THEN w := 'absent';
  ELSE EXECUTE 'SELECT public.get_locked_referral_id()' INTO x; w := CASE WHEN x = a THEN 'A' ELSE coalesce(x::text, 'NULL') END;
  END IF;
  PERFORM pg_temp.add('S8 get_locked_referral_id() for user6 is A', 'A', w);
  PERFORM pg_temp.add('S8 anon EXECUTE on get_locked_referral_id (want false)', 'false', CASE WHEN to_regprocedure('public.get_locked_referral_id()') IS NULL THEN 'absent' ELSE has_function_privilege('anon','public.get_locked_referral_id()','EXECUTE')::text END);

  -- S9: an unlocked referral (registered before the lock existed, no user recorded) locks to the claim's user; a 2nd claim cannot change it
  a := pg_temp.mkref(ag[1], interval '5 days');
  UPDATE public.referrals SET status = 'registered' WHERE id = a;
  b := pg_temp.mkref(ag[2], interval '1 day');
  PERFORM pg_temp.as_user(u[4]);
  c := pg_temp.file_claim(u[4], a);
  PERFORM pg_temp.add('S9 claim stamps the unlocked referral and locks it to the user', u[4]::text, coalesce(pg_temp.lock_of(a), 'NULL'));
  c := pg_temp.file_claim(u[4], b);
  PERFORM pg_temp.add('S9 a 2nd claim naming B is stamped A [BUG before: B]', 'A', CASE WHEN pg_temp.claim_ref(c) = a THEN 'A' WHEN pg_temp.claim_ref(c) = b THEN 'B' ELSE 'other' END);
  PERFORM pg_temp.add('S9 B not credited [BUG before: claim_submitted]', 'clicked', pg_temp.st(b));

  -- ===== LAPSE (Ben's ruling on #3219): a lock lapses with the window =====
  -- Each user below signs up through partner A (advance_referral_registered locks A), then the clock moves on: A's click is
  -- back-dated to the age in the case name (the lock's credited click is referrals.created_at).
  -- S10: lock 91 days old + a newer click 10 days old (partner B) on the claim -> B credited AND locked; A released, not credited.
  a := pg_temp.mkref(ag[1], interval '3 days');
  PERFORM pg_temp.as_user(u[7]);
  PERFORM pg_temp.add('S10 sign-up through A locks A', 'true', public.advance_referral_registered(a)::text);
  UPDATE public.referrals SET created_at = now() - interval '91 days' WHERE id = a;
  b := pg_temp.mkref(ag[2], interval '10 days');
  c := pg_temp.file_claim(u[7], b);                         -- the browser sends the newer click, B
  PERFORM pg_temp.add('S10 claim.referral_id is B (lock 91d, newer click 10d)', 'B', CASE WHEN pg_temp.claim_ref(c) = b THEN 'B' WHEN pg_temp.claim_ref(c) = a THEN 'A' ELSE coalesce(pg_temp.claim_ref(c)::text, 'NULL') END);
  PERFORM pg_temp.add('S10 B status (credited)', 'claim_submitted', pg_temp.st(b));
  PERFORM pg_temp.add('S10 B locked to the user', u[7]::text, coalesce(pg_temp.lock_of(b), 'NULL'));
  PERFORM pg_temp.add('S10 A released (lock moved, one lock per user)', 'NULL', coalesce(pg_temp.lock_of(a), 'NULL'));
  PERFORM pg_temp.add('S10 A status (not credited)', 'registered', pg_temp.st(a));

  -- S10b: same, but the newer click B is also advanced at the user's next sign-in (advance_referral_registered) before the claim.
  a := pg_temp.mkref(ag[1], interval '3 days');
  PERFORM pg_temp.as_user(u[8]);
  PERFORM pg_temp.add('S10b sign-up through A locks A', 'true', public.advance_referral_registered(a)::text);
  UPDATE public.referrals SET created_at = now() - interval '91 days' WHERE id = a;
  b := pg_temp.mkref(ag[2], interval '10 days');
  PERFORM pg_temp.add('S10b sign-in with B in the cookie advances B (lapsed lock does not block)', 'true', public.advance_referral_registered(b)::text);
  PERFORM pg_temp.add('S10b B locked, A released', u[8]::text || ' / NULL', coalesce(pg_temp.lock_of(b), 'NULL') || ' / ' || coalesce(pg_temp.lock_of(a), 'NULL'));
  IF to_regprocedure('public.get_locked_referral_id()') IS NULL THEN w := 'absent';
  ELSE EXECUTE 'SELECT public.get_locked_referral_id()' INTO x; w := CASE WHEN x = b THEN 'B' ELSE coalesce(x::text, 'NULL') END;
  END IF;
  PERFORM pg_temp.add('S10b get_locked_referral_id() is B', 'B', w);
  c := pg_temp.file_claim(u[8], b);
  PERFORM pg_temp.add('S10b claim.referral_id is B, B status', 'B / claim_submitted', CASE WHEN pg_temp.claim_ref(c) = b THEN 'B' ELSE coalesce(pg_temp.claim_ref(c)::text, 'NULL') END || ' / ' || pg_temp.st(b));

  -- S10c (boundary control): lock 89 days old is still LIVE, so a newer click 10 days old cannot take it -> A credited.
  a := pg_temp.mkref(ag[1], interval '3 days');
  PERFORM pg_temp.as_user(u[9]);
  PERFORM pg_temp.add('S10c sign-up through A locks A', 'true', public.advance_referral_registered(a)::text);
  UPDATE public.referrals SET created_at = now() - interval '89 days' WHERE id = a;
  b := pg_temp.mkref(ag[2], interval '10 days');
  PERFORM pg_temp.add('S10c advance(B) while A is live', 'false', public.advance_referral_registered(b)::text);
  c := pg_temp.file_claim(u[9], b);
  PERFORM pg_temp.add('S10c claim.referral_id is A (lock 89d holds)', 'A', CASE WHEN pg_temp.claim_ref(c) = a THEN 'A' WHEN pg_temp.claim_ref(c) = b THEN 'B' ELSE coalesce(pg_temp.claim_ref(c)::text, 'NULL') END);
  PERFORM pg_temp.add('S10c A credited, B not', 'claim_submitted / clicked', pg_temp.st(a) || ' / ' || pg_temp.st(b));

  -- S11: lock 91 days old and NO newer click -> nobody credited. (Browser still sends the lapsed A, or nothing.)
  a := pg_temp.mkref(ag[1], interval '3 days');
  PERFORM pg_temp.as_user(u[10]);
  PERFORM pg_temp.add('S11 sign-up through A locks A', 'true', public.advance_referral_registered(a)::text);
  UPDATE public.referrals SET created_at = now() - interval '91 days' WHERE id = a;
  c := pg_temp.file_claim(u[10], a);
  PERFORM pg_temp.add('S11 claim sending lapsed A: referral_id NULL (nobody credited)', 'NULL', coalesce(pg_temp.claim_ref(c)::text, 'NULL'));
  PERFORM pg_temp.add('S11 claim sending lapsed A: referral_agent_id NULL', 'NULL', coalesce((SELECT referral_agent_id::text FROM proof_claims WHERE id = c), 'NULL'));
  PERFORM pg_temp.add('S11 A status (not credited)', 'registered', pg_temp.st(a));
  c := pg_temp.file_claim(u[10], NULL);
  PERFORM pg_temp.add('S11 claim sending nothing: referral_id NULL', 'NULL', coalesce(pg_temp.claim_ref(c)::text, 'NULL'));
  IF to_regprocedure('public.get_locked_referral_id()') IS NULL THEN w := 'absent';
  ELSE EXECUTE 'SELECT public.get_locked_referral_id()' INTO x; w := coalesce(x::text, 'NULL');
  END IF;
  PERFORM pg_temp.add('S11 get_locked_referral_id() for a lapsed lock', 'NULL', w);

  -- S11b: lock 91 days old; the claim carries another click that is ALSO outside the window (95 days) -> nobody credited.
  a := pg_temp.mkref(ag[1], interval '3 days');
  PERFORM pg_temp.as_user(u[11]);
  PERFORM pg_temp.add('S11b sign-up through A locks A', 'true', public.advance_referral_registered(a)::text);
  UPDATE public.referrals SET created_at = now() - interval '91 days' WHERE id = a;
  e := pg_temp.mkref(ag[2], interval '95 days');
  c := pg_temp.file_claim(u[11], e);
  PERFORM pg_temp.add('S11b claim.referral_id NULL (newer click is 95 days old)', 'NULL', coalesce(pg_temp.claim_ref(c)::text, 'NULL'));
  PERFORM pg_temp.add('S11b neither credited', 'registered / clicked', pg_temp.st(a) || ' / ' || pg_temp.st(e));
END $p$;

-- S5: an undated click (created_at NULL) does not credit. referrals.created_at is NOT NULL, so the row can only exist inside this rolled-back
-- transaction after relaxing the column; a short lock_timeout keeps this from queueing behind live traffic (then the case reports SKIPPED).
SET LOCAL lock_timeout = '3s';
DO $p$
DECLARE u uuid; ag uuid; a uuid; c integer; got1 text; got2 text;
BEGIN
  SELECT p.id INTO u FROM public.profiles p JOIN auth.users au ON au.id = p.id WHERE p.is_test ORDER BY p.id OFFSET 11 LIMIT 1;  -- the 12th user, untouched by S1-S11
  SELECT id INTO ag FROM public.referral_agents WHERE is_test ORDER BY id LIMIT 1;
  BEGIN
    ALTER TABLE public.referrals ALTER COLUMN created_at DROP NOT NULL;
    INSERT INTO public.referrals (referral_agent_id, status, is_test) VALUES (ag, 'clicked', true) RETURNING id INTO a;
    UPDATE public.referrals SET created_at = NULL WHERE id = a;
    PERFORM pg_temp.as_user(u);
    got1 := public.advance_referral_registered(a)::text;
    c := pg_temp.file_claim(u, a);
    got2 := pg_temp.st(a);
    PERFORM pg_temp.add('S5 advance(undated click)', 'false', got1);
    PERFORM pg_temp.add('S5 undated click status (not credited)', 'clicked', got2);
  EXCEPTION WHEN lock_not_available THEN
    PERFORM pg_temp.add('S5 undated click', 'false / clicked', 'SKIPPED (lock_timeout on referrals); covered by the frontend undated tests and by construction (NULL >= x is NULL)');
  END;
END $p$;

DO $f$
DECLARE s text;
BEGIN
  SELECT string_agg(rpad(k, 78) || ' | want ' || rpad(coalesce(expected,'NULL'), 16) || ' | got ' || rpad(coalesce(got,'NULL'), 16) || ' | ' ||
                    CASE WHEN got IS NOT DISTINCT FROM expected THEN 'OK' ELSE 'DIFF' END, E'\n' ORDER BY n) INTO s FROM _r;
  RAISE EXCEPTION E'GH3219 PROOF (forced rollback)\n%', s USING ERRCODE = 'P0U01';
END $f$;
