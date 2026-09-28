-- gh-2300 (HO-1.S16 / HO-2.S16) proof: set_lead_converted's link window is 8 days.
--
-- Run the WHOLE file as one batch. It opens its own BEGIN and ends in ROLLBACK, so nothing it
-- writes survives. NEVER change the ROLLBACK to COMMIT. Run it against a database that has
-- supabase/migrations/20260928215500_gh2300_set_lead_converted_8day_window.sql applied (or paste
-- that migration's CREATE OR REPLACE inside the same transaction, above the DO block).
--
-- NOTE ON FIXTURES: trg_leads_force_safe_insert_defaults forces created_at := now() on INSERT
-- (gh-1994), so a lead cannot be inserted with an old created_at -- the age is set with an UPDATE
-- after the insert (the trigger is BEFORE INSERT only). The earlier gh2121_s16 proof passed
-- created_at = now() - 2 hours on INSERT, which the trigger silently overwrote, so it never
-- exercised any age.
--
-- Cases (each lead is linked by its own existing account id; results come back as the final SELECT):
--   W1  2-day-old lead, matching email          -> links (true)          FAILS on the 24 h function
--   W2  7.5-day-old lead, matching email        -> links (true)          (inside the reminder's 7-day max + slack)
--   W3  9-day-old lead, matching email          -> does NOT link (false) (window still bounded)
--   W4  2-day-old lead, DIFFERENT email         -> does NOT link (false) (negative control: D4 guard intact)
--   W5  2-day-old lead, already linked to owner -> second caller does NOT overwrite (first write wins)
--   W6  anon (no uid)                           -> raises 28000

BEGIN;

CREATE TEMP TABLE proof_results (case_id text, expected text, got text, pass boolean) ON COMMIT DROP;

DO $proof$
DECLARE
  v_uid_1 uuid;
  v_uid_2 uuid;
  v_uid_3 uuid;
  v_uid_4 uuid;
  v_uid_5 uuid;
  v_uid_5b uuid;
  v_l1 uuid; v_l2 uuid; v_l3 uuid; v_l4 uuid; v_l5 uuid;
  v_ok boolean;
  v_linked uuid;
  v_state text;
  v_uids uuid[];
BEGIN
  -- leads.converted_user_id has an FK to auth.users(id), so the synthetic callers must be real
  -- account ids. Six existing ids are READ (nothing is written to auth.users); the only rows this
  -- block writes are the five gh2300-*@example.test leads, rolled back below.
  SELECT array_agg(id) INTO v_uids FROM (SELECT id FROM auth.users ORDER BY id LIMIT 6) u;
  IF coalesce(cardinality(v_uids),0) < 6 THEN RAISE EXCEPTION 'need 6 auth.users rows'; END IF;
  v_uid_1 := v_uids[1]; v_uid_2 := v_uids[2]; v_uid_3 := v_uids[3]; v_uid_4 := v_uids[4]; v_uid_5 := v_uids[5]; v_uid_5b := v_uids[6];
  INSERT INTO public.leads (email, name, source) VALUES ('gh2300-w1@example.test','W1','facebook') RETURNING id INTO v_l1;
  INSERT INTO public.leads (email, name, source) VALUES ('gh2300-w2@example.test','W2','facebook') RETURNING id INTO v_l2;
  INSERT INTO public.leads (email, name, source) VALUES ('gh2300-w3@example.test','W3','facebook') RETURNING id INTO v_l3;
  INSERT INTO public.leads (email, name, source) VALUES ('gh2300-w4@example.test','W4','facebook') RETURNING id INTO v_l4;
  INSERT INTO public.leads (email, name, source) VALUES ('gh2300-w5@example.test','W5','facebook') RETURNING id INTO v_l5;
  UPDATE public.leads SET created_at = now() - interval '2 days'        WHERE id IN (v_l1, v_l4, v_l5);
  UPDATE public.leads SET created_at = now() - interval '7 days 12 hours' WHERE id = v_l2;
  UPDATE public.leads SET created_at = now() - interval '9 days'        WHERE id = v_l3;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid_1::text, 'email', 'gh2300-w1@example.test')::text, true);
  v_ok := public.set_lead_converted(v_l1);
  SELECT converted_user_id INTO v_linked FROM public.leads WHERE id = v_l1;
  INSERT INTO proof_results VALUES ('W1 2-day-old links', 'true+true', v_ok::text || '+' || coalesce(v_linked = v_uid_1, false)::text, coalesce(v_ok IS TRUE AND v_linked = v_uid_1, false));

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid_2::text, 'email', 'GH2300-W2@example.test')::text, true);
  v_ok := public.set_lead_converted(v_l2);
  SELECT converted_user_id INTO v_linked FROM public.leads WHERE id = v_l2;
  INSERT INTO proof_results VALUES ('W2 7.5-day-old links (case-insensitive email)', 'true+true', v_ok::text || '+' || coalesce(v_linked = v_uid_2, false)::text, coalesce(v_ok IS TRUE AND v_linked = v_uid_2, false));

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid_3::text, 'email', 'gh2300-w3@example.test')::text, true);
  v_ok := public.set_lead_converted(v_l3);
  SELECT converted_user_id INTO v_linked FROM public.leads WHERE id = v_l3;
  INSERT INTO proof_results VALUES ('W3 9-day-old does NOT link', 'false+true', v_ok::text || '+' || (v_linked IS NULL)::text, v_ok IS FALSE AND v_linked IS NULL);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid_4::text, 'email', 'someone-else@example.test')::text, true);
  v_ok := public.set_lead_converted(v_l4);
  SELECT converted_user_id INTO v_linked FROM public.leads WHERE id = v_l4;
  INSERT INTO proof_results VALUES ('W4 different-email 2-day-old does NOT link (negative control)', 'false+true', v_ok::text || '+' || (v_linked IS NULL)::text, v_ok IS FALSE AND v_linked IS NULL);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid_5::text, 'email', 'gh2300-w5@example.test')::text, true);
  PERFORM public.set_lead_converted(v_l5);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid_5b::text, 'email', 'gh2300-w5@example.test')::text, true);
  v_ok := public.set_lead_converted(v_l5);
  SELECT converted_user_id INTO v_linked FROM public.leads WHERE id = v_l5;
  INSERT INTO proof_results VALUES ('W5 first write wins', 'false+first', v_ok::text || '+' || CASE WHEN v_linked IS NOT DISTINCT FROM v_uid_5 THEN 'first' ELSE 'other' END, coalesce(v_ok IS FALSE AND v_linked = v_uid_5, false));

  PERFORM set_config('request.jwt.claims', '{}', true);
  BEGIN
    PERFORM public.set_lead_converted(v_l1);
    v_state := 'no error';
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  INSERT INTO proof_results VALUES ('W6 anon rejected', '28000', v_state, v_state = '28000');
END
$proof$;

SELECT case_id, expected, got, pass FROM proof_results ORDER BY case_id;

ROLLBACK;
