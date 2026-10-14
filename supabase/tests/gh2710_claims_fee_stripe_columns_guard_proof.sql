-- gh-2710 proof: the claims.platform_fee_stripe_id / platform_fee_amount write guard. Run on a THROWAWAY Postgres only
-- (supabase/tests/gh2710_claims_fee_stripe_columns_guard_proof_run.sh does it); never point it at production.
-- The schema is supabase/tests/gh2519_gh2564_throwaway_schema.sql (production's claims, quotes, contractors
-- and their guards as read 2026-10-08). The script is one transaction that ends in a RAISE (undo) and prints one
-- line per attempt. The runner executes it three times: TODAY (no guard), AFTER (forward applied), ROLLBACK
-- (rollback applied; must print exactly what TODAY printed).
-- The script ends in RAISE (the undo), never COMMIT; the runner treats the 'undo' error as success.
-- Each attempt runs as role authenticated (or anon / service_role) with a JWT sub, in its own exception block.
-- Fixture rows are inserted as the table owner (the guard does not apply to it) and carry is_test = true.
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
  c uuid; r text;
  col text := 'platform_fee_stripe_id = ''ch_forged'', platform_fee_amount = 1';
BEGIN
  INSERT INTO public.claims(user_id, status, is_test) VALUES (owner_id, 'bidding', true) RETURNING id INTO c;
  INSERT INTO proof_log(line) VALUES ('GUARD trigger claims_guard_fee_stripe_columns present: ' || EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.claims'::regclass AND tgname = 'claims_guard_fee_stripe_columns' AND NOT tgisinternal));
  INSERT INTO proof_log(line) VALUES ('GRANT authenticated UPDATE on claims.platform_fee_stripe_id: ' || has_column_privilege('authenticated','public.claims','platform_fee_stripe_id','UPDATE') || ' platform_fee_amount: ' || has_column_privilege('authenticated','public.claims','platform_fee_amount','UPDATE'));
  INSERT INTO proof_log(line) VALUES (format('FIXTURE claim is_test=%s stripe_id=%s amount=%s', (SELECT is_test FROM claims WHERE id=c), (SELECT platform_fee_stripe_id FROM claims WHERE id=c), (SELECT platform_fee_amount FROM claims WHERE id=c)));

  -- U1 the closes-on statement: the owner rewrites both columns (the defect / the negative control)
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('UPDATE public.claims SET platform_fee_stripe_id = ''ch_forged'', platform_fee_amount = 1 WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('U1 owner UPDATE stripe_id=ch_forged, amount=1 (negative control): ' || r || ' -> now ' || (SELECT coalesce(platform_fee_stripe_id,'NULL') || '/' || coalesce(platform_fee_amount::text,'NULL') FROM claims WHERE id=c));
  UPDATE public.claims SET platform_fee_stripe_id = NULL, platform_fee_amount = NULL WHERE id = c;

  -- U2 stripe id only
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('UPDATE public.claims SET platform_fee_stripe_id = ''ch_forged'' WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('U2 owner UPDATE platform_fee_stripe_id only: ' || r || ' -> now ' || (SELECT coalesce(platform_fee_stripe_id,'NULL') FROM claims WHERE id=c));
  UPDATE public.claims SET platform_fee_stripe_id = NULL WHERE id = c;

  -- U3 amount only
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('UPDATE public.claims SET platform_fee_amount = 1 WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('U3 owner UPDATE platform_fee_amount only: ' || r || ' -> now ' || (SELECT coalesce(platform_fee_amount::text,'NULL') FROM claims WHERE id=c));
  UPDATE public.claims SET platform_fee_amount = NULL WHERE id = c;

  -- U4 the owner rewrites / clears a value the webhook recorded
  UPDATE public.claims SET platform_fee_stripe_id = 'ch_real', platform_fee_amount = 250.00 WHERE id = c;
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('UPDATE public.claims SET platform_fee_stripe_id = NULL WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('U4 owner UPDATE platform_fee_stripe_id=NULL on a recorded charge: ' || r || ' -> now ' || (SELECT coalesce(platform_fee_stripe_id,'NULL') FROM claims WHERE id=c));
  UPDATE public.claims SET platform_fee_stripe_id = 'ch_real' WHERE id = c;

  -- U5 unchanged values re-sent alongside another change are not a change
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('UPDATE public.claims SET platform_fee_stripe_id = ''ch_real'', platform_fee_amount = 250.00, status = ''waitlisted'' WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('U5 owner UPDATE both columns unchanged + status=waitlisted: ' || r);
  UPDATE public.claims SET status = 'bidding' WHERE id = c;

  -- U6 an ordinary owner write that does not name the columns
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('UPDATE public.claims SET status = ''waitlisted'' WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('U6 owner UPDATE status=waitlisted (columns not named): ' || r);
  UPDATE public.claims SET status = 'bidding' WHERE id = c;

  -- U7 a stranger cannot reach the row (RLS), guard or not
  r := pg_temp.try_as('authenticated', other_id, 'stranger@example.invalid', format('UPDATE public.claims SET platform_fee_stripe_id = ''ch_forged'' WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('U7 stranger UPDATE platform_fee_stripe_id: ' || r || ' -> now ' || (SELECT platform_fee_stripe_id FROM claims WHERE id=c));

  -- S1 service_role writes both (docusign-webhook card path / stripe-webhook ACH path)
  UPDATE public.claims SET platform_fee_stripe_id = NULL, platform_fee_amount = NULL WHERE id = c;
  r := pg_temp.try_as('service_role', NULL, NULL, format('UPDATE public.claims SET platform_fee_stripe_id = ''ch_webhook'', platform_fee_amount = 250.00 WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('S1 service_role UPDATE stripe_id=ch_webhook, amount=250 (the webhooks): ' || r || ' -> now ' || (SELECT coalesce(platform_fee_stripe_id,'NULL') || '/' || coalesce(platform_fee_amount::text,'NULL') FROM claims WHERE id=c));
  -- S2 service_role writes the stripe id alone (the ACH settle path writes only that column)
  UPDATE public.claims SET platform_fee_stripe_id = NULL, platform_fee_amount = NULL WHERE id = c;
  r := pg_temp.try_as('service_role', NULL, NULL, format('UPDATE public.claims SET platform_fee_stripe_id = ''ch_ach'' WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('S2 service_role UPDATE platform_fee_stripe_id only (ACH settle): ' || r || ' -> now ' || (SELECT coalesce(platform_fee_stripe_id,'NULL') FROM claims WHERE id=c));
  UPDATE public.claims SET platform_fee_stripe_id = NULL WHERE id = c;

  -- A1 an admin session
  r := pg_temp.try_as('authenticated', other_id, 'dustinstohler1@gmail.com', format('UPDATE public.claims SET platform_fee_stripe_id = ''ch_admin'' WHERE id = %L', c));
  INSERT INTO proof_log(line) VALUES ('A1 admin UPDATE platform_fee_stripe_id: ' || r);
  UPDATE public.claims SET platform_fee_stripe_id = NULL WHERE id = c;

  -- I1 INSERT of a claim born with a forged stripe id
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('INSERT INTO public.claims(user_id, status, is_test, platform_fee_stripe_id) VALUES (%L, ''documents_needed'', true, ''ch_forged'')', owner_id));
  INSERT INTO proof_log(line) VALUES ('I1 owner INSERT claim with platform_fee_stripe_id (negative control): ' || r);
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('INSERT INTO public.claims(user_id, status, is_test, platform_fee_amount) VALUES (%L, ''documents_needed'', true, 1)', owner_id));
  INSERT INTO proof_log(line) VALUES ('I2 owner INSERT claim with platform_fee_amount: ' || r);
  r := pg_temp.try_as('authenticated', owner_id, 'owner@example.invalid', format('INSERT INTO public.claims(user_id, status, is_test) VALUES (%L, ''documents_needed'', true)', owner_id));
  INSERT INTO proof_log(line) VALUES ('I3 owner INSERT claim, columns omitted: ' || r);
  r := pg_temp.try_as('service_role', NULL, NULL, format('INSERT INTO public.claims(user_id, status, is_test, platform_fee_stripe_id, platform_fee_amount) VALUES (%L, ''documents_needed'', true, ''ch_backfill'', 10)', other_id));
  INSERT INTO proof_log(line) VALUES ('I4 service_role INSERT claim with both columns: ' || r);

  INSERT INTO proof_log(line) VALUES ('END owner-owned claims holding a forged stripe id/amount after all attempts: ' || (SELECT count(*) FROM claims WHERE user_id = owner_id AND (platform_fee_stripe_id IS NOT NULL OR platform_fee_amount IS NOT NULL)));
END
$proof$;
SELECT line FROM proof_log ORDER BY n;
-- undo: nothing above is ever committed
DO $undo$ BEGIN RAISE EXCEPTION 'undo: gh2710 proof rolled back'; END $undo$;
