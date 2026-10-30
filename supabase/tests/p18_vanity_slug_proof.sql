-- P18 proof (#3218): partner vanity slug data layer (draft migration
-- supabase/migrations_drafts/p18_vanity_slug_data.sql).
-- Run against production (yeszghaspzwwstvsrioa) as ONE statement batch forced to roll back (R-173/R-174: only is_test rows are
-- addressed; the last statement is a deliberate RAISE EXCEPTION, so nothing commits), same shape as gh2997_inherit_is_test_proof.sql.
--   BEFORE the migration : run this file alone  -> negative control: set_partner_slug is absent, every probe errors.
--   AFTER                : run the migration body (its own BEGIN; / COMMIT; lines removed) spliced at @@MIGRATION@@, same batch.
-- Fixtures (both is_test=true, status active, agent_type re_agent, slug NULL; verified by SELECT):
--   A = 9bf90639-269c-41b6-9d99-153ea187b36b (user fe97bbb6-6117-4147-98e4-be28e9f78bda, unique_code JFY5GZOD)
--   B = 80219b53-6f78-46ef-9236-2c2802faa9ea (user 24bd2fbb-8ec3-44bc-8495-5c0adaef1f3c, unique_code ZN73R8GY)
-- Each probe prints OK or REFUSED <sqlstate> <message>. Expected AFTER: P1 OK; every N-line REFUSED with the stated state;
-- H-lines as written. The closes-on negatives are N1 'admin', N2 'partners', N3 'Partners', N4 existing slug, N5 'ab', N6 'a--b',
-- N7 direct UPDATE of referral_agents.vanity_slug.

CREATE TEMP TABLE _r(k text, v text) ON COMMIT DROP;
-- @@MIGRATION@@

-- Run set_partner_slug as an authenticated partner (JWT claims set transaction-locally, role switched, then reset).
CREATE FUNCTION pg_temp._rpc(uid uuid, s text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE out text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', 'p18-proof@example.test')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    out := 'OK ' || (SELECT public.set_partner_slug(s))::text;
  EXCEPTION WHEN OTHERS THEN
    out := 'REFUSED ' || SQLSTATE || ' ' || left(SQLERRM, 90);
  END;
  RESET ROLE;
  RETURN out;
END $f$;

-- Run a raw statement as an authenticated partner (the direct-UPDATE path the picker must not have).
CREATE FUNCTION pg_temp._raw(uid uuid, stmt text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE out text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', 'p18-proof@example.test')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    EXECUTE stmt;
    GET DIAGNOSTICS n = ROW_COUNT;
    out := 'OK rows=' || n;
  EXCEPTION WHEN OTHERS THEN
    out := 'REFUSED ' || SQLSTATE || ' ' || left(SQLERRM, 90);
  END;
  RESET ROLE;
  RETURN out;
END $f$;

DO $t$
DECLARE
  a constant uuid := 'fe97bbb6-6117-4147-98e4-be28e9f78bda';
  b constant uuid := '24bd2fbb-8ec3-44bc-8495-5c0adaef1f3c';
  aid constant uuid := '9bf90639-269c-41b6-9d99-153ea187b36b';
  bid constant uuid := '80219b53-6f78-46ef-9236-2c2802faa9ea';
  x text;
BEGIN
  INSERT INTO _r VALUES ('F0 fixtures active+is_test', (SELECT string_agg(id::text || ':' || is_test || ':' || status, ',' ORDER BY id) FROM referral_agents WHERE id IN (aid, bid)));
  INSERT INTO _r VALUES ('F0 vanity_slug column', coalesce((SELECT 'present' FROM information_schema.columns WHERE table_schema='public' AND table_name='referral_agents' AND column_name='vanity_slug'), 'absent'));
  INSERT INTO _r VALUES ('F0 set_partner_slug', coalesce(to_regprocedure('public.set_partner_slug(text)')::text, 'absent'));
  IF to_regprocedure('public.set_partner_slug(text)') IS NULL THEN
    INSERT INTO _r VALUES ('NC negative control', 'migration not applied: no probe can run, so nothing is accepted or refused');
    RETURN;
  END IF;

  -- positive
  INSERT INTO _r VALUES ('P1 A set_partner_slug(jane-doe)  [want OK]', pg_temp._rpc(a, 'jane-doe'));
  EXECUTE 'SELECT vanity_slug FROM referral_agents WHERE id = $1' INTO x USING aid;
  INSERT INTO _r VALUES ('P1 stored value [want jane-doe]', coalesce(x, 'NULL'));
  INSERT INTO _r VALUES ('P2 A same slug again, mixed case [want OK changed=false]', pg_temp._rpc(a, 'JANE-doe'));

  -- negative controls
  INSERT INTO _r VALUES ('N1 admin (reserved) [want REFUSED 22023]', pg_temp._rpc(b, 'admin'));
  INSERT INTO _r VALUES ('N2 partners (reserved) [want REFUSED 22023]', pg_temp._rpc(b, 'partners'));
  INSERT INTO _r VALUES ('N3 Partners (reserved, case) [want REFUSED 22023]', pg_temp._rpc(b, 'Partners'));
  INSERT INTO _r VALUES ('N4 existing slug, other case, B takes A''s [want REFUSED 22023]', pg_temp._rpc(b, 'Jane-Doe'));
  INSERT INTO _r VALUES ('N5 ab (too short) [want REFUSED 22023]', pg_temp._rpc(b, 'ab'));
  INSERT INTO _r VALUES ('N6 a--b (double hyphen) [want REFUSED 22023]', pg_temp._rpc(b, 'a--b'));
  INSERT INTO _r VALUES ('N7 direct UPDATE vanity_slug as B [want REFUSED 42501]', pg_temp._raw(b, format('UPDATE referral_agents SET vanity_slug = %L WHERE id = %L', 'sneaky-b', bid)));
  INSERT INTO _r VALUES ('N7b direct UPDATE clearing A''s slug as A [want REFUSED 42501]', pg_temp._raw(a, format('UPDATE referral_agents SET vanity_slug = NULL WHERE id = %L', aid)));
  EXECUTE 'SELECT vanity_slug FROM referral_agents WHERE id = $1' INTO x USING bid;
  INSERT INTO _r VALUES ('N7 B slug after refused UPDATE [want NULL]', coalesce(x, 'NULL'));

  -- more rules
  INSERT INTO _r VALUES ('N8 -ab (leading hyphen)',  pg_temp._rpc(b, '-ab'));
  INSERT INTO _r VALUES ('N9 ab- (trailing hyphen)', pg_temp._rpc(b, 'ab-'));
  INSERT INTO _r VALUES ('N10 123456 (all digits)',  pg_temp._rpc(b, '123456'));
  INSERT INTO _r VALUES ('N11 a_b (bad char)',       pg_temp._rpc(b, 'a_b'));
  INSERT INTO _r VALUES ('N12 31 chars',             pg_temp._rpc(b, repeat('a', 31)));
  INSERT INTO _r VALUES ('N13 30 chars [want OK]',   pg_temp._rpc(b, repeat('b', 30)));
  INSERT INTO _r VALUES ('N14 profanity',            pg_temp._rpc(b, 'big-shit-roofs'));
  INSERT INTO _r VALUES ('N15 brand impersonation',  pg_temp._rpc(b, 'the-otterquote-team'));
  INSERT INTO _r VALUES ('N16 own unique_code lower-cased (ZN73R8GY)', pg_temp._rpc(b, 'zn73r8gy'));
  INSERT INTO _r VALUES ('N17 other partner''s unique_code (JFY5GZOD)', pg_temp._rpc(b, 'JFY5GZOD'));
  INSERT INTO _r VALUES ('N18 repo file name partner-dashboard', pg_temp._rpc(b, 'partner-dashboard'));
  INSERT INTO _r VALUES ('N19 named-list entry the-ashes',       pg_temp._rpc(b, 'the-ashes'));
  INSERT INTO _r VALUES ('N20 NULL input', pg_temp._rpc(b, NULL));
  INSERT INTO _r VALUES ('N21 no sign-in (sub null) [want REFUSED 42501]', pg_temp._rpc(NULL, 'someone'));
  INSERT INTO _r VALUES ('N22 anon may execute / authenticated may execute [want false,true]',
    coalesce(has_function_privilege('anon', 'public.set_partner_slug(text)', 'EXECUTE')::text, 'absent') || ',' ||
    coalesce(has_function_privilege('authenticated', 'public.set_partner_slug(text)', 'EXECUTE')::text, 'absent'));

  -- history: a changed slug keeps crediting
  INSERT INTO _r VALUES ('H1 A changes to jane-d [want OK]', pg_temp._rpc(a, 'jane-d'));
  INSERT INTO _r VALUES ('H1 history of A [want jane-doe]', coalesce((SELECT string_agg(slug, ',') FROM referral_agent_slug_history WHERE referral_agent_id = aid), 'NONE'));
  INSERT INTO _r VALUES ('H2 B takes A''s retired jane-doe [want REFUSED 22023]', pg_temp._rpc(b, 'jane-doe'));
  INSERT INTO _r VALUES ('H3 A re-claims jane-doe [want OK]', pg_temp._rpc(a, 'jane-doe'));
  INSERT INTO _r VALUES ('H3 history of A [want jane-d]', coalesce((SELECT string_agg(slug, ',') FROM referral_agent_slug_history WHERE referral_agent_id = aid), 'NONE'));

  -- backstops (service_role path skips the RPC): CHECK and unique index still bite
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  BEGIN UPDATE referral_agents SET vanity_slug = 'Bad_Slug' WHERE id = bid; INSERT INTO _r VALUES ('B1 service_role bad format', 'OK');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('B1 service_role bad format [want REFUSED 23514]', 'REFUSED ' || SQLSTATE); END;
  BEGIN UPDATE referral_agents SET vanity_slug = 'jane-doe' WHERE id = bid; INSERT INTO _r VALUES ('B2 service_role duplicate', 'OK');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('B2 service_role duplicate [want REFUSED 23505]', 'REFUSED ' || SQLSTATE); END;
  BEGIN UPDATE referral_agents SET vanity_slug = 'svc-set' WHERE id = bid; UPDATE referral_agents SET vanity_slug = 'svc-set-2' WHERE id = bid;
    INSERT INTO _r VALUES ('B3 service_role change archives old [want the 30-b slug then svc-set]', coalesce((SELECT string_agg(slug, ',') FROM referral_agent_slug_history WHERE referral_agent_id = bid), 'NONE'));
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES ('B3 ERROR', SQLSTATE || ' ' || left(SQLERRM, 80)); END;

  INSERT INTO _r VALUES ('S1 function search_path pinned', coalesce((SELECT proconfig::text FROM pg_proc WHERE proname = 'set_partner_slug' AND pronamespace = 'public'::regnamespace), 'absent'));
  INSERT INTO _r VALUES ('S1 SECURITY DEFINER', coalesce((SELECT prosecdef::text FROM pg_proc WHERE proname = 'set_partner_slug' AND pronamespace = 'public'::regnamespace), 'absent'));
  INSERT INTO _r VALUES ('S2 reserved_slugs rows', coalesce((SELECT count(*)::text FROM reserved_slugs), 'absent'));
END $t$;

DO $f$
DECLARE s text;
BEGIN
  SELECT string_agg(k || ' => ' || coalesce(v,'NULL'), E'\n' ORDER BY ctid) INTO s FROM _r;
  RAISE EXCEPTION E'P18 PROOF (forced rollback)\n%', s USING ERRCODE = 'P0U01';
END $f$;
