-- gh-2875 (D-391) proof for supabase/migrations_drafts/gh2875_d391_contractor_sms_numbers.sql. THROWAWAY Postgres only.
-- Run by supabase/tests/gh2875_d391_contractor_sms_numbers_proof_run.sh against: TODAY (main, no forward), AFTER (forward),
-- MUTANT (forward, then client writes re-granted and the replace-only trigger dropped) and ROLLBACK (forward then rollback).
-- Prints one line per check: <id> <what> ACCEPTED rows=<n> | REJECTED <sqlstate> | VALUE <x>. Fixtures are fake, no real number.
\set ON_ERROR_STOP 0
\pset tuples_only on
\pset format unaligned
CREATE OR REPLACE FUNCTION pg_temp.try(label text, q text, as_role text, sub text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN sub IS NULL THEN json_build_object('role', as_role)::text
                     ELSE json_build_object('role', as_role, 'sub', sub, 'email', 'c@example.test')::text END, true);
  PERFORM set_config('role', as_role, true);
  EXECUTE q; GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('role', 'none', true);
  RETURN label || ' ACCEPTED rows=' || n;
EXCEPTION WHEN others THEN
  RETURN label || ' REJECTED ' || SQLSTATE;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.val(label text, q text, as_role text, sub text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN sub IS NULL THEN json_build_object('role', as_role)::text
                     ELSE json_build_object('role', as_role, 'sub', sub, 'email', 'c@example.test')::text END, true);
  PERFORM set_config('role', as_role, true);
  EXECUTE q INTO v;
  PERFORM set_config('role', 'none', true);
  RETURN label || ' VALUE ' || coalesce(v, '<null>');
EXCEPTION WHEN others THEN
  RETURN label || ' REJECTED ' || SQLSTATE;
END $$;

BEGIN;
-- fixtures, as the table owner (the Edge Functions' service_role path is exercised by the checks below)
INSERT INTO public.contractors (id, user_id) VALUES
  ('a0000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-00000000000a'),
  ('b0000000-0000-4000-8000-00000000000b', 'b1000000-0000-4000-8000-00000000000b');
SELECT pg_temp.try('F0 fixture disclosure v-test', $q$INSERT INTO public.sms_disclosure_versions (id, program_name, disclosure_text)
  VALUES ('v-test', 'TEST PROGRAM', 'TEST DISCLOSURE TEXT, not the legal wording')$q$, 'service_role');
SELECT pg_temp.try('F1 fixture A numbers', $q$INSERT INTO public.contractor_sms_numbers
  (id, contractor_id, user_id, phone_e164, is_primary, verified_at, last_confirmed_at, disclosure_version_id, disclosure_text, verification_method, source)
  VALUES
  ('a2000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-00000000000a','a1000000-0000-4000-8000-00000000000a','+15550000001', true,  now()-interval '100 days', now()-interval '100 days','v-test','TEST DISCLOSURE TEXT, not the legal wording','sms_otp','signup'),
  ('a2000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-00000000000a','a1000000-0000-4000-8000-00000000000a','+15550000003', false, now()-interval '500 days', now()-interval '400 days','v-test','TEST DISCLOSURE TEXT, not the legal wording','sms_otp','settings'),
  ('a2000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-00000000000a','a1000000-0000-4000-8000-00000000000a','+15550000002', false, now()-interval '50 days',  now()-interval '50 days', 'v-test','TEST DISCLOSURE TEXT, not the legal wording','sms_otp','settings'),
  ('a2000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-00000000000a','a1000000-0000-4000-8000-00000000000a','+15550000004', false, now()-interval '200 days', now()-interval '20 days', 'v-test','TEST DISCLOSURE TEXT, not the legal wording','sms_otp','settings')$q$, 'service_role');
SELECT pg_temp.try('F2 fixture B only number', $q$INSERT INTO public.contractor_sms_numbers
  (id, contractor_id, user_id, phone_e164, is_primary, verified_at, last_confirmed_at, disclosure_version_id, disclosure_text, verification_method, source)
  VALUES ('b2000000-0000-4000-8000-000000000005','b0000000-0000-4000-8000-00000000000b','b1000000-0000-4000-8000-00000000000b','+15550000005', true, now()-interval '10 days', now()-interval '10 days','v-test','TEST DISCLOSURE TEXT, not the legal wording','sms_otp','signup')$q$, 'service_role');
SELECT pg_temp.try('F3 fixture suppress +15550000004', $q$INSERT INTO public.sms_suppression_list (phone_e164, keyword, channel) VALUES ('+15550000004','STOP','sms_keyword')$q$, 'service_role');

-- client write paths (must be refused after the forward)
SELECT pg_temp.try('P1 contractor INSERTs a number for itself', $q$INSERT INTO public.contractor_sms_numbers
  (contractor_id, user_id, phone_e164, verified_at, last_confirmed_at, disclosure_version_id, disclosure_text, verification_method, source)
  VALUES ('a0000000-0000-4000-8000-00000000000a','a1000000-0000-4000-8000-00000000000a','+15559999999', now(), now(),'v-test','x','sms_otp','settings')$q$,
  'authenticated', 'a1000000-0000-4000-8000-00000000000a');
SELECT pg_temp.try('P2 contractor UPDATEs its own number', $q$UPDATE public.contractor_sms_numbers SET phone_e164 = '+15559999998'
  WHERE id = 'a2000000-0000-4000-8000-000000000001'$q$, 'authenticated', 'a1000000-0000-4000-8000-00000000000a');
SELECT pg_temp.try('P3 contractor DELETEs suppression rows', $q$DELETE FROM public.sms_suppression_list$q$, 'authenticated', 'a1000000-0000-4000-8000-00000000000a');
SELECT pg_temp.val('P4 contractor A sees own numbers', $q$SELECT count(*)::text FROM public.contractor_sms_numbers$q$, 'authenticated', 'a1000000-0000-4000-8000-00000000000a');
SELECT pg_temp.val('P5 contractor B sees own numbers', $q$SELECT count(*)::text FROM public.contractor_sms_numbers$q$, 'authenticated', 'b1000000-0000-4000-8000-00000000000b');
SELECT pg_temp.try('P6 contractor calls the sender read', $q$SELECT * FROM public.contractor_textable_numbers('a0000000-0000-4000-8000-00000000000a')$q$, 'authenticated', 'a1000000-0000-4000-8000-00000000000a');
SELECT pg_temp.try('P7 anon reads numbers', $q$SELECT * FROM public.contractor_sms_numbers$q$, 'anon');
SELECT pg_temp.try('P8 anon reads disclosure versions', $q$SELECT * FROM public.sms_disclosure_versions$q$, 'anon');
-- sender read
SELECT pg_temp.val('P9 textable(A) (verified, confirmed <395d, not suppressed)', $q$SELECT string_agg(phone_e164 || CASE WHEN is_primary THEN '*' ELSE '' END, ',') FROM public.contractor_textable_numbers('a0000000-0000-4000-8000-00000000000a')$q$, 'service_role');
-- no consent record, no number
SELECT pg_temp.try('P10 number without disclosure text', $q$INSERT INTO public.contractor_sms_numbers
  (contractor_id, user_id, phone_e164, verified_at, last_confirmed_at, disclosure_version_id, verification_method, source)
  VALUES ('a0000000-0000-4000-8000-00000000000a','a1000000-0000-4000-8000-00000000000a','+15559999997', now(), now(),'v-test','sms_otp','settings')$q$, 'service_role');
SELECT pg_temp.try('P11 number with unknown disclosure version', $q$INSERT INTO public.contractor_sms_numbers
  (contractor_id, user_id, phone_e164, verified_at, last_confirmed_at, disclosure_version_id, disclosure_text, verification_method, source)
  VALUES ('a0000000-0000-4000-8000-00000000000a','a1000000-0000-4000-8000-00000000000a','+15559999996', now(), now(),'v-none','x','sms_otp','settings')$q$, 'service_role');
-- replace-only and opt-out
SELECT pg_temp.try('P12 remove B''s last verified number', $q$UPDATE public.contractor_sms_numbers SET status = 'removed' WHERE id = 'b2000000-0000-4000-8000-000000000005'$q$, 'service_role');
SELECT pg_temp.try('P13 disable B''s last verified number', $q$UPDATE public.contractor_sms_numbers SET status = 'disabled' WHERE id = 'b2000000-0000-4000-8000-000000000005'$q$, 'service_role');
SELECT pg_temp.try('P14 opt-out of B''s last number (always honoured)', $q$UPDATE public.contractor_sms_numbers SET status = 'opted_out', opted_out_at = now(), opt_out_keyword = 'STOP', opt_out_channel = 'sms_keyword' WHERE id = 'b2000000-0000-4000-8000-000000000005'$q$, 'service_role');
SELECT pg_temp.val('P15 textable(B) after its only number opted out', $q$SELECT count(*)::text FROM public.contractor_textable_numbers('b0000000-0000-4000-8000-00000000000b')$q$, 'service_role');
SELECT pg_temp.try('P16 primary of A opts out', $q$UPDATE public.contractor_sms_numbers SET status = 'opted_out', opted_out_at = now(), opt_out_keyword = 'STOP', opt_out_channel = 'sms_keyword' WHERE id = 'a2000000-0000-4000-8000-000000000001'$q$, 'service_role');
SELECT pg_temp.val('P17 A''s new primary (oldest textable verified)', $q$SELECT string_agg(phone_e164, ',') FROM public.contractor_sms_numbers WHERE contractor_id = 'a0000000-0000-4000-8000-00000000000a' AND is_primary$q$, 'service_role');
SELECT pg_temp.try('P18 second primary for A', $q$UPDATE public.contractor_sms_numbers SET is_primary = true WHERE id = 'a2000000-0000-4000-8000-000000000003'$q$, 'service_role');
SELECT pg_temp.try('P19 release suppression without START', $q$UPDATE public.sms_suppression_list SET released_at = now(), released_keyword = 'hello' WHERE phone_e164 = '+15550000004'$q$, 'service_role');
SELECT pg_temp.try('P20 release suppression with START', $q$UPDATE public.sms_suppression_list SET released_at = now(), released_keyword = 'START' WHERE phone_e164 = '+15550000004'$q$, 'service_role');
SELECT pg_temp.val('P21 textable(A) after START', $q$SELECT string_agg(phone_e164 || CASE WHEN is_primary THEN '*' ELSE '' END, ',') FROM public.contractor_textable_numbers('a0000000-0000-4000-8000-00000000000a')$q$, 'service_role');
SELECT pg_temp.try('P22 staff action without reason', $q$INSERT INTO public.contractor_sms_staff_actions (contractor_id, actor_email, action, reason) VALUES ('a0000000-0000-4000-8000-00000000000a','staff@example.test','disable','  ')$q$, 'service_role');
SELECT pg_temp.val('P23 default preference', $q$WITH i AS (INSERT INTO public.contractor_sms_number_preferences (number_id) VALUES ('a2000000-0000-4000-8000-000000000002') RETURNING categories) SELECT array_to_string(categories, ',') FROM i$q$, 'service_role');
SELECT pg_temp.try('P24 release suppression with YES (START only)', $q$UPDATE public.sms_suppression_list SET released_at = NULL, released_keyword = NULL WHERE phone_e164 = '+15550000004';
  INSERT INTO public.sms_suppression_list (phone_e164, keyword, channel, released_at, released_keyword) VALUES ('+15550000006','STOP','sms_keyword', now(), 'YES')$q$, 'service_role');
-- retention: a contractor hard delete (purge script, e2e deleteUser cascade) must not delete consent records
SELECT pg_temp.try('P25 hard-delete contractor A', $q$DELETE FROM public.contractors WHERE id = 'a0000000-0000-4000-8000-00000000000a'$q$, 'postgres');
SELECT pg_temp.val('P26 A''s consent records after the delete', $q$SELECT count(*)::text FROM public.contractor_sms_numbers WHERE contractor_id = 'a0000000-0000-4000-8000-00000000000a'$q$, 'service_role');
SELECT pg_temp.try('P27 delete A''s last verified number', $q$DELETE FROM public.contractor_sms_numbers WHERE contractor_id = 'a0000000-0000-4000-8000-00000000000a' AND status = 'verified'$q$, 'service_role');
ROLLBACK;
