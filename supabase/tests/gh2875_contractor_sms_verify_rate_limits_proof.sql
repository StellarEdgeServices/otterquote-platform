-- gh-2875 (D-391 layer 2): proof for supabase/migrations_drafts/gh2875_contractor_sms_verify_rate_limits.sql.
-- Run ONLY by gh2875_contractor_sms_verify_rate_limits_proof_run.sh on a throwaway Postgres. NEVER against production.
-- Each line is "<id> <what> VALUE <result>"; the runner asserts them per database (TODAY / AFTER / TWICE / PREEXIST / MUTANT / ROLLBACK).
-- pg_temp.req() replays handler.ts L238-245 at c7162ab60f422ee0 (main, #3043 merge): for one request it calls
-- check_rate_limit(<key>, bucket) for bucket = the account id, then bucket = bucketUuid("phone", phone) (L104-111, mirrored below),
-- and stops at the first refusal, exactly like the handler (index.ts L44-47: allowed only when data.allowed is true).
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset format unaligned

CREATE FUNCTION pg_temp.phone_bucket(p_phone text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE d bytea := substring(sha256(convert_to('contractor-sms-verify:phone:' || p_phone, 'UTF8')) FROM 1 FOR 16);
BEGIN
  d := set_byte(d, 6, (get_byte(d, 6) & 15) | 64);
  d := set_byte(d, 8, (get_byte(d, 8) & 63) | 128);
  RETURN encode(d, 'hex')::uuid;
END $f$;

CREATE FUNCTION pg_temp.req(p_key text, p_user uuid, p_phone text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE b uuid; r jsonb;
BEGIN
  FOREACH b IN ARRAY ARRAY[p_user, pg_temp.phone_bucket(p_phone)] LOOP
    r := public.check_rate_limit(p_function_name => p_key, p_user_id => b);
    IF (r ->> 'allowed') IS DISTINCT FROM 'true' THEN
      RETURN 'denied:' || split_part(COALESCE(r ->> 'reason', '?'), ':', 1);
    END IF;
  END LOOP;
  RETURN 'allowed';
END $f$;

-- n requests in a row; returns "<allowed count>/<n> last=<last outcome>"
CREATE FUNCTION pg_temp.burst(p_key text, p_user uuid, p_phone text, n int) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE i int; ok int := 0; last text;
BEGIN
  FOR i IN 1..n LOOP
    last := pg_temp.req(p_key, p_user, p_phone);
    IF last = 'allowed' THEN ok := ok + 1; END IF;
  END LOOP;
  RETURN ok || '/' || n || ' last=' || last;
END $f$;

-- seed n allowed log rows for one caller (or n random callers when p_caller is NULL), backdated by p_age
CREATE FUNCTION pg_temp.seed(p_key text, p_caller uuid, n int, p_age interval) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.rate_limits (function_name, caller_id, called_at, blocked)
  SELECT p_key, COALESCE(p_caller, gen_random_uuid()), now() - p_age, false FROM generate_series(1, n)
$f$;

-- Q0: bucket mirror sanity (a fixed vector, so a drift in the mirror is visible)
SELECT 'Q0 phone bucket of +15555550100 VALUE ' || pg_temp.phone_bucket('+15555550100');

-- Q1/Q2: one fresh account + number, first request per key (TODAY and ROLLBACK must deny: no config row = fail closed)
TRUNCATE public.rate_limits;
SELECT 'Q1 start first request VALUE ' || pg_temp.req('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000001', '+15555550101');
SELECT 'Q2 check first request VALUE ' || pg_temp.req('contractor-sms-verify-check', '00000000-0000-4000-8000-000000000001', '+15555550101');

-- Q3: start burst, one account + one number, 6 requests in an hour -> 5 allowed, 6th refused hourly
TRUNCATE public.rate_limits;
SELECT 'Q3 start burst 6 VALUE ' || pg_temp.burst('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000003', '+15555550103', 6);
-- Q4: a DIFFERENT account asking for the SAME number is refused by the number bucket (the documented burn)
SELECT 'Q4 other account same number VALUE ' || pg_temp.req('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000004', '+15555550103');
-- Q5: the first account asking for a DIFFERENT number is refused by its own account bucket
SELECT 'Q5 same account other number VALUE ' || pg_temp.req('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000003', '+15555550105');
-- Q6: an unrelated account + number is not affected
SELECT 'Q6 unrelated account and number VALUE ' || pg_temp.req('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000006', '+15555550106');
-- Q7: the start key does not consume the check key (separate rows): a check on the burnt pair is still allowed
SELECT 'Q7 check after start burst VALUE ' || pg_temp.req('contractor-sms-verify-check', '00000000-0000-4000-8000-000000000003', '+15555550103');

-- Q8: check burst, 11 in an hour -> 10 allowed, 11th refused hourly
TRUNCATE public.rate_limits;
SELECT 'Q8 check burst 11 VALUE ' || pg_temp.burst('contractor-sms-verify-check', '00000000-0000-4000-8000-000000000008', '+15555550108', 11);

-- Q9/Q10: day window. 9 (then 10) start rows 2 hours old on an account -> next allowed (then refused daily)
TRUNCATE public.rate_limits;
SELECT pg_temp.seed('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000009', 9, '2 hours');
SELECT 'Q9 start after 9 earlier today VALUE ' || pg_temp.req('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000009', '+15555550109');
SELECT 'Q10 start after 10 earlier today VALUE ' || pg_temp.req('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000009', '+15555550110');

-- Q11/Q12: month window. 29 (then 30) start rows 3 days old -> next allowed (then refused monthly)
TRUNCATE public.rate_limits;
SELECT pg_temp.seed('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000011', 29, '3 days');
SELECT 'Q11 start after 29 this month VALUE ' || pg_temp.req('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000011', '+15555550111');
SELECT 'Q12 start after 30 this month VALUE ' || pg_temp.req('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000011', '+15555550112');

-- Q13/Q14: global budget cap on start. 342 rows from other callers -> spend 9.9864 < 10.00, allowed (that request adds 2 rows);
-- then 343+ rows -> refused budget_cap for a brand-new account and number.
TRUNCATE public.rate_limits;
SELECT pg_temp.seed('contractor-sms-verify-start', NULL, 341, '3 days');
SELECT 'Q13 start at 341 global rows VALUE ' || pg_temp.req('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000013', '+15555550113');
SELECT 'Q14 start at 343 global rows VALUE ' || pg_temp.req('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000014', '+15555550114');

-- Q15: check has no budget cap: 5000 global rows from other callers, a new pair is still allowed
TRUNCATE public.rate_limits;
SELECT pg_temp.seed('contractor-sms-verify-check', NULL, 5000, '3 days');
SELECT 'Q15 check at 5000 global rows VALUE ' || pg_temp.req('contractor-sms-verify-check', '00000000-0000-4000-8000-000000000015', '+15555550115');

-- Q16: an hour later the hourly refusal clears (5 rows 61 minutes old)
TRUNCATE public.rate_limits;
SELECT pg_temp.seed('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000016', 5, '61 minutes');
SELECT 'Q16 start after 5 rows 61 min old VALUE ' || pg_temp.req('contractor-sms-verify-start', '00000000-0000-4000-8000-000000000016', '+15555550116');

-- R: the config rows themselves, and the unrelated row
SELECT 'R1 config rows VALUE ' || COALESCE(string_agg(format('%s=%s/%s/%s/%s/%s/%s', function_name, max_per_hour, max_per_day, max_per_month,
         enabled, monthly_cost_estimate, monthly_budget_cap), ',' ORDER BY function_name), 'none')
  FROM public.rate_limit_config WHERE function_name LIKE 'contractor-sms-verify%';
SELECT 'R2 send-sms row VALUE ' || COALESCE((SELECT format('%s/%s/%s/%s/%s', max_per_hour, max_per_day, max_per_month, monthly_cost_estimate, monthly_budget_cap)
  FROM public.rate_limit_config WHERE function_name = 'send-sms'), 'none');
SELECT 'R3 config row count VALUE ' || count(*) FROM public.rate_limit_config;
