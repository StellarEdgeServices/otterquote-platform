-- gh-2491 proof: the claims.platform_fee_charged write guard. Run on a THROWAWAY Postgres only
-- (supabase/tests/gh2491_platform_fee_charged_guard_proof_run.sh does it); never point it at production.
-- The schema is supabase/tests/gh2519_gh2564_throwaway_schema.sql (production's claims, quotes, contractors
-- and their guards as read 2026-10-08). The script is one transaction that ends in ROLLBACK and prints one
-- line per attempt. The runner executes it three times: TODAY (no guard), AFTER (forward applied), ROLLBACK
-- (rollback applied; must print exactly what TODAY printed).
-- Each attempt runs as role authenticated (or anon / service_role) with a JWT sub, in its own exception block.
-- Fixture rows are inserted as the table owner (the guard does not apply to it) and carry is_test = true.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE proof_log(n serial, line text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_email text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 110);
  END;
END $f$;
DO $proof$
DECLARE
  owner_id uuid := gen_random_uuid(); other_id uuid := gen_random_uuid();
  c uuid; c2 uuid;
  guard_present boolean;
  r text;
BEGIN
  INSERT INTO public.claims(user_id, status, is_test) VALUES (owner_id, 'bidding', true) RETURNING id INTO c;
  guard_present := EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.claims'::regclass AND tgname = 'claims_guard_platform_fee_charged' AND NOT tgisinternal);
  INSERT INTO proof_log(line) VALUES ('GUARD trigger claims_guard_platform_fee_charged present: ' || guard_present);
  INSERT INTO proof_log(line) VALUES ('GRANT authenticated UPDATE on claims.platform_fee_charged: ' || has_column_privilege('authenticated','public.claims','platform_fee_charged','UPDATE'));
  INSERT INTO proof_log(line) VALUES (format('FIXTURE claim is_test=%s platform_fee_charged=%s', (SELECT is_test FROM claims WHERE id=c), (SELECT platform_fee_charged FROM claims WHERE id=c)));

  -- U1 the defect / the control: the claim owner sets the flag true on their own claim
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('UPDATE public.claims SET platform_fee_charged = true WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('U1 owner UPDATE platform_fee_charged=true (negative control): ' || r || ' -> flag now ' || (SELECT platform_fee_charged FROM claims WHERE id=c));
  UPDATE public.claims SET platform_fee_charged = false WHERE id = c;

  -- U2 the owner clears the flag on a charged claim
  UPDATE public.claims SET platform_fee_charged = true WHERE id = c;
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('UPDATE public.claims SET platform_fee_charged = false WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('U2 owner UPDATE platform_fee_charged=false on a charged claim: ' || r || ' -> flag now ' || (SELECT platform_fee_charged FROM claims WHERE id=c));
  UPDATE public.claims SET platform_fee_charged = false WHERE id = c;

  -- U3 an unchanged value re-sent alongside another change is not a change
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('UPDATE public.claims SET platform_fee_charged = false, status = ''waitlisted'' WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('U3 owner UPDATE platform_fee_charged=false (unchanged) + status=waitlisted: ' || r);
  UPDATE public.claims SET status = 'bidding' WHERE id = c;

  -- U4 an ordinary owner write that does not name the column
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('UPDATE public.claims SET status = ''waitlisted'' WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('U4 owner UPDATE status=waitlisted (column not named): ' || r);
  UPDATE public.claims SET status = 'bidding' WHERE id = c;

  -- U5 a stranger (not the owner) cannot reach the row at all (RLS), guard or not
  r := pg_temp.try_as('authenticated', other_id, 'stranger@example.invalid', format('UPDATE public.claims SET platform_fee_charged = true WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('U5 stranger UPDATE platform_fee_charged=true: ' || r || ' -> flag now ' || (SELECT platform_fee_charged FROM claims WHERE id=c));
  UPDATE public.claims SET platform_fee_charged = false WHERE id = c;

  -- S1 service_role (docusign-webhook, stripe-webhook) sets the flag
  r := pg_temp.try_as('service_role', NULL, NULL, format('UPDATE public.claims SET platform_fee_charged = true WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('S1 service_role UPDATE platform_fee_charged=true (the webhooks): ' || r || ' -> flag now ' || (SELECT platform_fee_charged FROM claims WHERE id=c));
  UPDATE public.claims SET platform_fee_charged = false WHERE id = c;

  -- A1 an admin session sets the flag
  r := pg_temp.try_as('authenticated', other_id, 'dustinstohler1@gmail.com', format('UPDATE public.claims SET platform_fee_charged = true WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('A1 admin UPDATE platform_fee_charged=true: ' || r || ' -> flag now ' || (SELECT platform_fee_charged FROM claims WHERE id=c));
  UPDATE public.claims SET platform_fee_charged = false WHERE id = c;

  -- I1 INSERT of a claim born with the flag true (a signed-in user, own user_id)
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('INSERT INTO public.claims(user_id, status, is_test, platform_fee_charged) VALUES (%L, ''documents_needed'', true, true)', owner_id));
  INSERT INTO proof_log(line) VALUES ('I1 owner INSERT claim with platform_fee_charged=true (negative control): ' || r);
  -- I2 INSERT of a claim with the flag omitted / false
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('INSERT INTO public.claims(user_id, status, is_test) VALUES (%L, ''documents_needed'', true)', owner_id));
  INSERT INTO proof_log(line) VALUES ('I2 owner INSERT claim, flag omitted: ' || r);
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('INSERT INTO public.claims(user_id, status, is_test, platform_fee_charged) VALUES (%L, ''documents_needed'', true, false)', owner_id));
  INSERT INTO proof_log(line) VALUES ('I3 owner INSERT claim, flag false: ' || r);

  -- I4 service_role inserts a claim already charged (a backfill-style write)
  r := pg_temp.try_as('service_role', NULL, NULL, format('INSERT INTO public.claims(user_id, status, is_test, platform_fee_charged) VALUES (%L, ''documents_needed'', true, true)', other_id));
  INSERT INTO proof_log(line) VALUES ('I4 service_role INSERT claim with platform_fee_charged=true: ' || r);

  INSERT INTO proof_log(line) VALUES ('END owner claims with flag true after all attempts (rows written by service_role only expected after the guard): ' || (SELECT count(*) FROM claims WHERE platform_fee_charged IS TRUE AND user_id = owner_id));
END
$proof$;
SELECT line FROM proof_log ORDER BY n;
ROLLBACK;
