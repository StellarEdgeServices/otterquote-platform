-- gh-2785 proof: profiles.is_test / email / role freeze. THROWAWAY Postgres only (gh2785_profiles_freeze_proof_run.sh).
-- One transaction ending in a RAISE (undo); one line per attempt. Run TODAY (no guard), AFTER (forward), ROLLBACK.
-- Each attempt runs as the named role with a JWT sub, in its own exception block. Fixtures are inserted as the owner.
BEGIN;
CREATE TEMP TABLE proof_log(n serial, line text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_email text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; EXECUTE 'RESET ROLE';
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 90);
  END;
END $f$;
DO $proof$
DECLARE
  me uuid := gen_random_uuid(); other uuid := gen_random_uuid(); r text;
  st text;
BEGIN
  INSERT INTO public.profiles(id, full_name, email, is_test) VALUES (me, 'Real Homeowner', 'real@example.invalid', false), (other, 'Other', 'other@example.invalid', false);
  INSERT INTO proof_log(line) VALUES ('GUARD trigger profiles_freeze_privileged_columns present: ' || EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.profiles'::regclass AND tgname='profiles_freeze_privileged_columns' AND NOT tgisinternal));
  INSERT INTO proof_log(line) VALUES ('GRANT authenticated UPDATE is_test: ' || has_column_privilege('authenticated','public.profiles','is_test','UPDATE') || ' role: ' || has_column_privilege('authenticated','public.profiles','role','UPDATE') || ' email: ' || has_column_privilege('authenticated','public.profiles','email','UPDATE'));

  -- U1 the closes-on statement: a real user flags themselves test (negative control: succeeds before the fix)
  r := pg_temp.try_as('authenticated', me, 'real@example.invalid', format('UPDATE public.profiles SET is_test = true WHERE id = %L', me));
  INSERT INTO proof_log(line) VALUES ('U1 self UPDATE is_test=true: ' || r || ' -> now is_test=' || (SELECT is_test FROM profiles WHERE id=me));
  UPDATE public.profiles SET is_test = false WHERE id = me;
  -- U2 email
  r := pg_temp.try_as('authenticated', me, 'real@example.invalid', format('UPDATE public.profiles SET email = ''forged@example.invalid'' WHERE id = %L', me));
  INSERT INTO proof_log(line) VALUES ('U2 self UPDATE email=forged: ' || r || ' -> now email=' || (SELECT email FROM profiles WHERE id=me));
  UPDATE public.profiles SET email = 'real@example.invalid' WHERE id = me;
  -- U3 role alone
  r := pg_temp.try_as('authenticated', me, 'real@example.invalid', format('UPDATE public.profiles SET role = ''contractor'' WHERE id = %L', me));
  INSERT INTO proof_log(line) VALUES ('U3 self UPDATE role=contractor: ' || r || ' -> now role=' || (SELECT role FROM profiles WHERE id=me));
  UPDATE public.profiles SET role = 'homeowner' WHERE id = me;
  -- U4 legacy client shape: contractor-signup update (auth.js) names role + other columns; other columns must still land
  r := pg_temp.try_as('authenticated', me, 'real@example.invalid', format('UPDATE public.profiles SET full_name = ''Signup Name'', phone = ''317'', role = ''contractor'', updated_at = now() WHERE id = %L', me));
  INSERT INTO proof_log(line) VALUES ('U4 self UPDATE full_name+phone+role=contractor (auth.js shape): ' || r || ' -> now name=' || (SELECT full_name FROM profiles WHERE id=me) || ' phone=' || (SELECT phone FROM profiles WHERE id=me) || ' role=' || (SELECT role FROM profiles WHERE id=me));
  UPDATE public.profiles SET full_name = 'Real Homeowner', phone = NULL, role = 'homeowner' WHERE id = me;
  -- U5 legacy client shape: upsert (INSERT .. ON CONFLICT DO UPDATE) naming role='homeowner' (trade-selector / dashboard)
  UPDATE public.profiles SET role = 'contractor' WHERE id = me;   -- owner-level: a multi-role user
  r := pg_temp.try_as('authenticated', me, 'real@example.invalid', format('INSERT INTO public.profiles(id, full_name, role) VALUES (%L, ''Upsert Name'', ''homeowner'') ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, role = EXCLUDED.role', me));
  INSERT INTO proof_log(line) VALUES ('U5 self upsert full_name+role=homeowner on a contractor row: ' || r || ' -> now name=' || (SELECT full_name FROM profiles WHERE id=me) || ' role=' || (SELECT role FROM profiles WHERE id=me));
  UPDATE public.profiles SET full_name = 'Real Homeowner', role = 'homeowner' WHERE id = me;
  -- U6 unchanged values re-sent (a full-row round trip) are not a change
  r := pg_temp.try_as('authenticated', me, 'real@example.invalid', format('UPDATE public.profiles SET email = ''real@example.invalid'', is_test = false, role = ''homeowner'', full_name = ''Renamed'' WHERE id = %L', me));
  INSERT INTO proof_log(line) VALUES ('U6 self UPDATE unchanged email/is_test/role + full_name=Renamed: ' || r || ' -> now name=' || (SELECT full_name FROM profiles WHERE id=me));
  UPDATE public.profiles SET full_name = 'Real Homeowner' WHERE id = me;
  -- U7 ordinary write not naming the columns
  r := pg_temp.try_as('authenticated', me, 'real@example.invalid', format('UPDATE public.profiles SET phone = ''555'' WHERE id = %L', me));
  INSERT INTO proof_log(line) VALUES ('U7 self UPDATE phone (columns not named): ' || r);
  -- U8 someone else's row (RLS), guard or not
  r := pg_temp.try_as('authenticated', me, 'real@example.invalid', format('UPDATE public.profiles SET is_test = true WHERE id = %L', other));
  INSERT INTO proof_log(line) VALUES ('U8 UPDATE another user''s is_test: ' || r || ' -> other is_test=' || (SELECT is_test FROM profiles WHERE id=other));
  -- U9 anon
  r := pg_temp.try_as('anon', NULL, NULL, format('UPDATE public.profiles SET is_test = true WHERE id = %L', me));
  INSERT INTO proof_log(line) VALUES ('U9 anon UPDATE is_test: ' || r);

  -- S1 service_role still can change all three
  r := pg_temp.try_as('service_role', NULL, NULL, format('UPDATE public.profiles SET is_test = true, email = ''svc@example.invalid'', role = ''contractor'' WHERE id = %L', me));
  INSERT INTO proof_log(line) VALUES ('S1 service_role UPDATE is_test+email+role: ' || r || ' -> now ' || (SELECT is_test::text || '/' || email || '/' || role FROM profiles WHERE id=me));
  UPDATE public.profiles SET is_test = false, email = 'real@example.invalid', role = 'homeowner' WHERE id = me;
  -- S2 owner (postgres) still can
  UPDATE public.profiles SET is_test = true, email = 'own@example.invalid', role = 'contractor' WHERE id = me;
  INSERT INTO proof_log(line) VALUES ('S2 owner UPDATE is_test+email+role: ACCEPTED -> now ' || (SELECT is_test::text || '/' || email || '/' || role FROM profiles WHERE id=me));
  UPDATE public.profiles SET is_test = false, email = 'real@example.invalid', role = 'homeowner' WHERE id = me;
  -- D1 the real contractor flip: authenticated inserts a contractors row, the SECURITY DEFINER trigger sets role
  r := pg_temp.try_as('authenticated', me, 'real@example.invalid', format('INSERT INTO public.contractors(user_id) VALUES (%L)', me));
  INSERT INTO proof_log(line) VALUES ('D1 authenticated INSERT contractors -> sync_contractor_profile_role: ' || r || ' -> now role=' || (SELECT role FROM profiles WHERE id=me));

  FOR st IN SELECT line FROM proof_log ORDER BY n LOOP NULL; END LOOP;
  INSERT INTO proof_log(line) VALUES ('END forged values held by me: ' || (SELECT count(*) FROM profiles WHERE id=me AND (is_test OR email <> 'real@example.invalid')));
END $proof$;
SELECT line FROM proof_log ORDER BY n;
DO $u$ BEGIN RAISE EXCEPTION 'undo: gh2785 proof rolled back'; END $u$;
