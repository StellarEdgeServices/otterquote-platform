-- gh-3212 proof: client roles cannot change claims.is_test (draft migration supabase/migrations_drafts/gh3212_freeze_claims_is_test.sql).
-- Run as ONE statement batch that is forced to roll back (the last statement is a deliberate RAISE EXCEPTION, nothing commits).
--   BEFORE the fix : run this file alone.                       -> defect: A1 and A2 show the owner's change SUCCEEDED
--   AFTER the fix  : run the migration body (its own BEGIN/COMMIT removed) followed by this file, same batch.
-- Fixtures: two throwaway auth.users (handle_new_user creates the profiles); claims are inserted as the batch owner (postgres) with
--   is_test = true, so no admin alert or GA4 send fires; the false fixture is made by a service_role UPDATE (step B1). Every result is
--   accumulated in one text variable and returned in the final exception message, so it survives the rollback.
-- Expected BEFORE: A1 owner true->false: CHANGED (defect); A2 owner false->true: CHANGED (defect); A3 anon: no row visible/updated; B* as below.
-- Expected AFTER : A1 REFUSED 42501; A2 REFUSED 42501; A3 REFUSED or 0 rows; N1 unchanged-is_test owner update OK;
--                  N2 owner update of another column OK; B1 service_role true->false: CHANGED; B2 postgres: CHANGED;
--                  C1 other owner (u_other) cannot reach the claim: 0 rows.
DO $t$
DECLARE
  u_own   uuid := gen_random_uuid();
  u_other uuid := gen_random_uuid();
  c1 uuid;
  r text := '';
  v text;
  n int;
BEGIN
  INSERT INTO auth.users(id, email) VALUES (u_own, 'proof+gh3212-own@example.com'), (u_other, 'proof+gh3212-other@example.com');
  INSERT INTO claims(user_id, status, is_test) VALUES (u_own, 'documents_needed', true) RETURNING id INTO c1;

  -- B1 negative control (service_role is NOT refused): true -> false. The fixture is now false.
  BEGIN
    SET LOCAL ROLE service_role;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    UPDATE claims SET is_test = false WHERE id = c1;
    GET DIAGNOSTICS n = ROW_COUNT;
    RESET ROLE;
    SELECT is_test::text INTO v FROM claims WHERE id = c1;
    r := r || E'\nB1 service_role true->false: rows=' || n || ' now is_test=' || v || ' (want rows=1 false, before and after)';
  EXCEPTION WHEN OTHERS THEN RESET ROLE; r := r || E'\nB1 ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;

  -- A2 owner flips a real claim (false) to test (true): the hide-from-alerts attack
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_own, 'email', 'proof+gh3212-own@example.com', 'role', 'authenticated')::text, true);
    UPDATE claims SET is_test = true WHERE id = c1;
    GET DIAGNOSTICS n = ROW_COUNT;
    RESET ROLE;
    SELECT is_test::text INTO v FROM claims WHERE id = c1;
    r := r || E'\nA2 owner false->true: rows=' || n || ' now is_test=' || v || ' (BEFORE: rows=1 true = defect; AFTER: refused)';
  EXCEPTION WHEN OTHERS THEN RESET ROLE; r := r || E'\nA2 owner false->true: REFUSED ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;
  SELECT is_test::text INTO v FROM claims WHERE id = c1;
  r := r || E'\n   claim after A2: is_test=' || v;

  -- reset to a known false for the next steps (batch owner)
  UPDATE claims SET is_test = false WHERE id = c1;

  -- N1 / N2 owner updates that must keep working: is_test named but unchanged; another column only
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_own, 'email', 'proof+gh3212-own@example.com', 'role', 'authenticated')::text, true);
    UPDATE claims SET is_test = false WHERE id = c1;
    GET DIAGNOSTICS n = ROW_COUNT;
    r := r || E'\nN1 owner is_test=false->false (unchanged): rows=' || n || ' (want 1, before and after)';
    UPDATE claims SET property_city = 'Proofville' WHERE id = c1;
    GET DIAGNOSTICS n = ROW_COUNT;
    r := r || E'\nN2 owner updates property_city: rows=' || n || ' (want 1, before and after)';
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN RESET ROLE; r := r || E'\nN1/N2 ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;

  -- put the claim back to true, then A1 owner flips a test claim (true) to real (false): the count-pollution case
  UPDATE claims SET is_test = true WHERE id = c1;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_own, 'email', 'proof+gh3212-own@example.com', 'role', 'authenticated')::text, true);
    UPDATE claims SET is_test = false WHERE id = c1;
    GET DIAGNOSTICS n = ROW_COUNT;
    RESET ROLE;
    SELECT is_test::text INTO v FROM claims WHERE id = c1;
    r := r || E'\nA1 owner true->false: rows=' || n || ' now is_test=' || v || ' (BEFORE: rows=1 false = defect; AFTER: refused)';
  EXCEPTION WHEN OTHERS THEN RESET ROLE; r := r || E'\nA1 owner true->false: REFUSED ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;

  -- A3 anon role
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    UPDATE claims SET is_test = false WHERE id = c1;
    GET DIAGNOSTICS n = ROW_COUNT;
    RESET ROLE;
    r := r || E'\nA3 anon true->false: rows=' || n || ' (want 0 or REFUSED, before and after; RLS may already hide the row)';
  EXCEPTION WHEN OTHERS THEN RESET ROLE; r := r || E'\nA3 anon: REFUSED ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;

  -- C1 a different signed-in user cannot reach the claim at all
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u_other, 'email', 'proof+gh3212-other@example.com', 'role', 'authenticated')::text, true);
    UPDATE claims SET is_test = false WHERE id = c1;
    GET DIAGNOSTICS n = ROW_COUNT;
    RESET ROLE;
    r := r || E'\nC1 other user: rows=' || n || ' (want 0, before and after)';
  EXCEPTION WHEN OTHERS THEN RESET ROLE; r := r || E'\nC1 other user: REFUSED ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;

  -- B2 batch owner (postgres, stands in for SECURITY DEFINER functions and the SQL editor): true -> false
  UPDATE claims SET is_test = true WHERE id = c1;
  UPDATE claims SET is_test = false WHERE id = c1;
  SELECT is_test::text INTO v FROM claims WHERE id = c1;
  r := r || E'\nB2 postgres true->false: now is_test=' || v || ' (want false, before and after)';

  -- P1 privileges and trigger presence (informational)
  SELECT has_column_privilege('authenticated', 'public.claims', 'is_test', 'UPDATE')::text || '/' || has_column_privilege('anon', 'public.claims', 'is_test', 'UPDATE')::text INTO v;
  r := r || E'\nP1 column UPDATE authenticated/anon (unchanged by this migration, true/true: the trigger, not a REVOKE, is the control): ' || v;
  SELECT coalesce(string_agg(tgname, ','), 'absent') INTO v FROM pg_trigger WHERE tgrelid = 'public.claims'::regclass AND tgname = 'claims_freeze_is_test';
  r := r || E'\nP2 trigger claims_freeze_is_test: ' || v || ' (BEFORE absent, AFTER present)';

  RAISE EXCEPTION E'GH3212 PROOF (forced rollback)%', r USING ERRCODE = 'P0U01';
END $t$;
