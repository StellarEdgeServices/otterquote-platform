-- Proof for gh2310 Gap 2 domain trigger (20260930140000_gh2310_gap2_referral_agents_internal_test_trigger).
-- For the APPLIER. Run AFTER the forward migration is applied, as ONE batch, as the table owner (postgres /
-- Management API database/query). BEGIN ... ROLLBACK only: nothing persists. Re-read the counts afterwards.
-- The proof inserts fixture rows WITHOUT is_test and reads back what the trigger did. Stacy's address is
-- constructed from her live row inside the script; no gmail literal is stored in this file.
-- The AFTER INSERT alert trigger (trg_notify_admin_new_partner, pg_net) is disabled inside the transaction
-- so fixtures cannot queue an admin alert; the DDL rolls back with everything else.
-- If a fixture INSERT fails on a NOT NULL column not listed here, add it to the INSERT below (columns added
-- after the v000 baseline could not be checked without DB access).
--
-- EXPECTED: NOTICE 'positive cases OK', NOTICE 'negative control OK: gh2310 proof mismatch: ...', then the
-- 'after' row shows fixtures_left = 0 and ra_total equal to the 'before' ra_total.
BEGIN;

SELECT 'before' AS phase, count(*) AS ra_total, count(*) FILTER (WHERE is_test = false) AS ra_false
FROM public.referral_agents;

ALTER TABLE public.referral_agents DISABLE TRIGGER trg_notify_admin_new_partner;

CREATE FUNCTION pg_temp.gh2310_run_cases(p_run text) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE
  c_stacy_id constant uuid := '0a934e11-5cac-4607-a63c-7446fe446f81'::uuid;
  v_stacy text;
  v_base  text;
  r       record;
  v_got   boolean;
  v_bad   text := '';
BEGIN
  SELECT email INTO v_stacy FROM public.referral_agents WHERE id = c_stacy_id;
  IF v_stacy IS NULL THEN
    RAISE EXCEPTION 'proof setup: Stacy row % missing or email null', c_stacy_id;
  END IF;
  v_base := split_part(split_part(lower(btrim(v_stacy)), '@', 1), '+', 1);

  FOR r IN
    SELECT * FROM (VALUES
      -- expected TRUE: the four internal domains
      ('domain stellaredgeservices.com',   'gh2310-' || p_run || '-a@stellaredgeservices.com',  true),
      ('domain tryotterquote.com',         'gh2310-' || p_run || '-b@tryotterquote.com',        true),
      ('domain stohlerroof.com',           'gh2310-' || p_run || '-c@stohlerroof.com',          true),
      ('domain otterquote-internal.test',  'gh2310-' || p_run || '-d@otterquote-internal.test', true),
      ('domain mixed case',                'GH2310-' || p_run || '-e@StellarEdgeServices.COM',  true),
      -- expected TRUE: Dustin's base with a plus tag, and Stacy's base (built from her live row) with a plus tag
      ('dustin plus-address',              'dustinstohler1+gh2310' || p_run || '@' || 'gmail.com', true),
      ('stacy plus-address (from live row)', v_base || '+gh2310' || p_run || '@' || 'gmail.com',  true),
      -- expected FALSE: real-looking control and near-misses
      ('control example.com',              'gh2310-' || p_run || '-f@example.com',              false),
      ('near-miss dustinstohler10',        'dustinstohler10+gh2310' || p_run || '@' || 'gmail.com', false),
      ('near-miss stacy base + digit',     v_base || '9+gh2310' || p_run || '@' || 'gmail.com',   false),
      ('near-miss lookalike domain',       'gh2310-' || p_run || '-g@stellaredgeservices.com.evil.io', false),
      ('near-miss prefixed domain',        'gh2310-' || p_run || '-h@notstohlerroof.com',       false),
      ('near-miss dustin base wrong domain', 'dustinstohler1+gh2310' || p_run || '@example.com', false),
      ('near-miss stacy base wrong domain',  v_base || '+gh2310' || p_run || '@example.com',    false)
    ) AS t(label, email, expect_test)
  LOOP
    INSERT INTO public.referral_agents (agent_type, first_name, last_name, email)
    VALUES ('re_agent', 'Proof', 'Gh2310', r.email)
    RETURNING is_test INTO v_got;
    IF v_got IS DISTINCT FROM r.expect_test THEN
      v_bad := v_bad || format('[%s: got %s expected %s] ', r.label, v_got, r.expect_test);
    END IF;
  END LOOP;

  -- explicit is_test=true on a non-internal address must stay true (trigger never sets false)
  INSERT INTO public.referral_agents (agent_type, first_name, last_name, email, is_test)
  VALUES ('re_agent', 'Proof', 'Gh2310', 'gh2310-' || p_run || '-i@example.com', true)
  RETURNING is_test INTO v_got;
  IF v_got IS DISTINCT FROM true THEN
    v_bad := v_bad || '[explicit true on external address was changed] ';
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'gh2310 proof mismatch: %', v_bad;
  END IF;
END
$f$;

-- 1. Positive: every case matches with the trigger enabled. Any mismatch RAISEs and aborts the batch.
SELECT pg_temp.gh2310_run_cases('pos');
DO $$ BEGIN RAISE NOTICE 'positive cases OK'; END $$;

-- 2. Negative control: with the trigger disabled the SAME assertions must FAIL (proves the proof depends on the trigger).
ALTER TABLE public.referral_agents DISABLE TRIGGER referral_agents_set_is_test_internal;
DO $$
BEGIN
  PERFORM pg_temp.gh2310_run_cases('neg');
  RAISE EXCEPTION 'NEGATIVE CONTROL FAILED: assertions passed with the trigger disabled';
EXCEPTION WHEN raise_exception THEN
  -- Exactly the 7 expected-TRUE cases must flip to false with the trigger off; any other count means the
  -- proof is measuring something other than this trigger.
  IF SQLERRM LIKE 'gh2310 proof mismatch%' AND (length(SQLERRM) - length(replace(SQLERRM, 'expected t]', ''))) / length('expected t]') = 7
     AND SQLERRM NOT LIKE '%expected f]%' THEN
    RAISE NOTICE 'negative control OK: %', SQLERRM;
  ELSE
    RAISE;
  END IF;
END
$$;
ALTER TABLE public.referral_agents ENABLE TRIGGER referral_agents_set_is_test_internal;

ROLLBACK;

SELECT 'after' AS phase, count(*) AS ra_total, count(*) FILTER (WHERE is_test = false) AS ra_false,
       count(*) FILTER (WHERE email ILIKE '%gh2310%') AS fixtures_left,
       (SELECT tgenabled FROM pg_trigger WHERE tgname = 'referral_agents_set_is_test_internal'
          AND tgrelid = 'public.referral_agents'::regclass) AS trigger_enabled_flag  -- expect 'O' (enabled)
FROM public.referral_agents;
