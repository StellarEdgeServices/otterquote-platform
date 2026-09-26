-- gh-2223 rate-limit fix -- reference/manual test harness.
--
-- Reference/manual test -- this repo has no pgTAP or SQL test runner wired
-- into CI for supabase/migrations*/ (same finding gh1961's harness
-- documented). Run against a scratch Postgres database named exactly
-- `gh2223_test` (the guard immediately below refuses to run anywhere else):
--
--   createdb gh2223_test   # once
--   psql -d gh2223_test -v ON_ERROR_STOP=1 \
--     -f supabase/migrations_drafts/gh2154_register_partner_rate_limit_fix.test.sql
--
-- REVISION 2026-09-26 (post-REVIEW:FAIL 5850688286, PR #2237 re-review):
--   - D1: added step 7, a spoofing negative control -- a forged LEFT-MOST
--     X-Forwarded-For hop must not change the rate-limit bucket when
--     cf-connecting-ip is present and fixed. The old harness (pre-fix
--     lines 498-644 of the original file) keyed only on x-forwarded-for
--     and would actually have PASSED with a bug in this exact shape --
--     see the do-block below for the demonstration.
--   - D3: rate_limit_client_key() now reads its salt from Vault
--     (vault.decrypted_secrets) and uses extensions.hmac(...) instead of
--     salted md5 -- this harness stubs vault.* and extensions.hmac() (via
--     pgcrypto, already loaded) rather than reproducing Vault itself, and
--     seeds one fixed salt so results are deterministic.
--   - D4: register_partner_test is now PER-CLIENT (v_client_key), not a
--     single shared NULL-key row -- step 3's assertions are updated to
--     check the per-client count, and a new check confirms a second,
--     different test client is not affected by the first one's test
--     volume.
--
-- Simplification, documented rather than silently assumed away: this
-- harness builds a MINIMAL `referral_agents` (only the columns
-- register_partner() actually reads or writes) and skips the four
-- production triggers on the real table (code/recruit-code generators,
-- the payout-column guard, and the new-partner admin-alert notifier) --
-- none of them affect rate-limit behavior, which is the only thing this
-- fix changes. `unique_code`/`recruit_code` get a plain default here
-- instead of the real generator functions. `check_rate_limit()`,
-- `is_test_email()`, `rate_limit_client_key()`, and `register_partner()`
-- themselves are the REAL bodies, pulled/authored verbatim -- nothing about
-- the rate-limit logic under test is paraphrased or stubbed.
--
-- auth.uid()/auth.role() are stubbed as simple SQL functions reading two
-- session GUCs (`test.uid`, `test.role`) so each test step can flip caller
-- identity/role without a real JWT.
--
-- It asserts, in order:
--   0. safety guard -- refuses to run against anything but the scratch DB
--   1. NEGATIVE CONTROL (per-client isolation): three real signups from
--      IP-A succeed and consume IP-A's own budget; a 4th from IP-A is
--      refused even though register_partner_global is nowhere near its
--      own limit -- proving the block is scoped to IP-A's key, not global.
--   2. NEGATIVE CONTROL (a different real client is unaffected): a real
--      signup from IP-B succeeds immediately while IP-A is still capped.
--   3. NEGATIVE CONTROL (test traffic never touches the real budget, and
--      D4: is itself per-client): six @otterquote-internal.test signups
--      from IP-A all succeed even though IP-A's REAL bucket is exhausted;
--      a 7th test signup from IP-A is refused once IP-A's OWN test budget
--      is hit, while a test signup from a DIFFERENT client (IP-B) at the
--      same time is unaffected by IP-A's test volume.
--   4. Global ceiling still protects against many-IP abuse (real-time
--      RAISE; alert delivery itself now lives in platform-health-check,
--      exercised in that function's own test/CI, not here).
--   5. Idempotency: the forward migration's config upserts are re-applied
--      a second time; exit 0, exactly one row per function_name survives.
--   6. (kept from the original harness, renumbered) -- see step 4 above;
--      no separate reconciler to test now that D2 moved alerting out of
--      SQL.
--   7. D1 SPOOFING NEGATIVE CONTROL: cf-connecting-ip fixed at
--      198.51.100.9 for 21 calls; x-forwarded-for's LEFT-MOST hop changes
--      on every call (what an attacker fully controls). Assert call 21
--      raises rate_limited -- i.e. all 21 calls landed in ONE bucket,
--      keyed by cf-connecting-ip, not by the attacker-supplied XFF.

\set ON_ERROR_STOP 1

do $$
begin
  if current_database() <> 'gh2223_test' then
    raise exception
      'gh2223 test harness: refusing to run against database % -- this '
      'script builds throwaway rate_limit_config/rate_limits/referral_agents/'
      'platform_alerts_log tables and must only ever run against a scratch '
      'database literally named gh2223_test. Create one (createdb '
      'gh2223_test) and reconnect.', current_database();
  end if;
end $$;

create extension if not exists pgcrypto;

begin;

-- === schema =================================================================

create table rate_limit_config (
  function_name text primary key,
  max_per_hour int not null,
  max_per_day int not null,
  max_per_month int not null,
  enabled boolean not null default true,
  monthly_cost_estimate numeric not null default 0,
  monthly_budget_cap numeric not null default 0,
  notes text,
  alert_sent_month text,
  notes_alert text
);

create table rate_limits (
  id uuid primary key default gen_random_uuid(),
  function_name text not null,
  called_at timestamptz not null default now(),
  caller_id uuid,
  metadata jsonb,
  blocked boolean not null default false
);

create table platform_alerts_log (
  id uuid primary key default gen_random_uuid(),
  alert_type text not null,
  function_name text not null,
  message text not null,
  sent_at timestamptz not null default now(),
  acknowledged_at timestamptz
);

create table referral_agents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  agent_type text not null,
  first_name text not null,
  last_name text not null,
  email text not null unique,
  phone text, company text, website text, service_area text, photo_url text,
  referred_by_note text,
  unique_code text not null default gen_random_uuid()::text,
  recruit_code text default gen_random_uuid()::text,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  recruited_by_id uuid,
  recruited_at timestamptz,
  utm_source text, utm_medium text, utm_campaign text, utm_content text,
  is_test boolean not null default false,
  partner_agreement_version text,
  partner_agreement_accepted_at timestamptz,
  partner_agreement_attestation jsonb not null default '{}'::jsonb,
  fbclid text, li_fat_id text, funnel_id text,
  meta_lead_id text unique
);

-- auth.uid()/auth.role() stubs, driven by session GUCs so each test step
-- can flip caller identity/role without a real JWT.
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid;
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('test.role', true), '');
$$;
select set_config('test.uid', '', false);
select set_config('test.role', 'anon', false);
select set_config('request.headers', '{}', false);

-- D3: Vault + extensions.hmac stubs. Real Supabase exposes vault.secrets /
-- vault.decrypted_secrets and pgcrypto's hmac() under the `extensions`
-- schema; this harness reproduces just enough of that surface for
-- rate_limit_client_key() to run unmodified, seeded with one fixed salt so
-- test output is deterministic run-to-run (production generates a real
-- random one at migration time, per the forward migration's DO block).
create schema if not exists vault;
create table vault.secrets (name text primary key, secret text);
create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
insert into vault.secrets (name, secret) values ('rate_limit_ip_salt', 'gh2223-test-harness-fixed-salt-do-not-use-in-prod');

create schema if not exists extensions;
create or replace function extensions.hmac(data text, key text, type text) returns bytea
 language sql immutable as $$ select hmac(data, key, type); $$;

-- is_test_email() -- REAL body, verbatim (public.is_test_email, live DB,
-- 2026-09-26).
create or replace function is_test_email(p_email text) returns boolean
 language sql immutable as $$
  select lower(btrim(coalesce(p_email, ''))) like '%@otterquote-internal.test';
$$;

-- check_rate_limit() -- REAL body, verbatim (public.check_rate_limit,
-- live DB, 2026-09-26), unmodified by this fix.
create or replace function check_rate_limit(p_function_name text, p_user_id uuid default null::uuid)
 returns jsonb language plpgsql as $function$
DECLARE
  config               rate_limit_config%ROWTYPE;
  hourly_count         int;
  daily_count          int;
  monthly_count        int;
  global_monthly_count int;
  monthly_spend        numeric;
BEGIN
  SELECT * INTO config FROM rate_limit_config WHERE function_name = p_function_name;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'No rate limit config found for function: ' || p_function_name || '. Denying by default.'
    );
  END IF;

  IF NOT config.enabled THEN
    INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
    VALUES (p_function_name, p_user_id, true, '{"reason": "function_disabled"}'::jsonb);

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'Function ' || p_function_name || ' is disabled via kill switch.'
    );
  END IF;

  SELECT COUNT(*) INTO hourly_count
  FROM rate_limits
  WHERE function_name = p_function_name
    AND (
      (p_user_id IS NOT NULL AND caller_id = p_user_id) OR
      (p_user_id IS NULL     AND caller_id IS NULL)
    )
    AND called_at > now() - interval '1 hour'
    AND NOT blocked;

  SELECT COUNT(*) INTO daily_count
  FROM rate_limits
  WHERE function_name = p_function_name
    AND (
      (p_user_id IS NOT NULL AND caller_id = p_user_id) OR
      (p_user_id IS NULL     AND caller_id IS NULL)
    )
    AND called_at > now() - interval '1 day'
    AND NOT blocked;

  SELECT COUNT(*) INTO monthly_count
  FROM rate_limits
  WHERE function_name = p_function_name
    AND (
      (p_user_id IS NOT NULL AND caller_id = p_user_id) OR
      (p_user_id IS NULL     AND caller_id IS NULL)
    )
    AND called_at > now() - interval '1 month'
    AND NOT blocked;

  IF hourly_count >= config.max_per_hour THEN
    INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
    VALUES (p_function_name, p_user_id, true,
      jsonb_build_object('reason', 'hourly_limit', 'count', hourly_count, 'limit', config.max_per_hour));

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', format('Hourly limit reached: %s/%s calls in the last hour.', hourly_count, config.max_per_hour),
      'counts', jsonb_build_object('hour', hourly_count, 'day', daily_count, 'month', monthly_count)
    );
  END IF;

  IF daily_count >= config.max_per_day THEN
    INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
    VALUES (p_function_name, p_user_id, true,
      jsonb_build_object('reason', 'daily_limit', 'count', daily_count, 'limit', config.max_per_day));

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', format('Daily limit reached: %s/%s calls today.', daily_count, config.max_per_day),
      'counts', jsonb_build_object('hour', hourly_count, 'day', daily_count, 'month', monthly_count)
    );
  END IF;

  IF monthly_count >= config.max_per_month THEN
    INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
    VALUES (p_function_name, p_user_id, true,
      jsonb_build_object('reason', 'monthly_limit', 'count', monthly_count, 'limit', config.max_per_month));

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', format('Monthly limit reached: %s/%s calls this month.', monthly_count, config.max_per_month),
      'counts', jsonb_build_object('hour', hourly_count, 'day', daily_count, 'month', monthly_count)
    );
  END IF;

  IF config.monthly_budget_cap > 0 THEN
    SELECT COUNT(*) INTO global_monthly_count
    FROM rate_limits
    WHERE function_name = p_function_name
      AND called_at > now() - interval '1 month'
      AND NOT blocked;

    monthly_spend := global_monthly_count * config.monthly_cost_estimate;
    IF monthly_spend >= config.monthly_budget_cap THEN
      INSERT INTO rate_limits (function_name, caller_id, blocked, metadata)
      VALUES (p_function_name, p_user_id, true,
        jsonb_build_object('reason', 'budget_cap', 'spend', monthly_spend, 'cap', config.monthly_budget_cap));

      RETURN jsonb_build_object(
        'allowed', false,
        'reason', format('Monthly budget cap reached: $%s/$%s estimated spend.', monthly_spend, config.monthly_budget_cap),
        'counts', jsonb_build_object('hour', hourly_count, 'day', daily_count, 'month', monthly_count),
        'estimated_spend', monthly_spend
      );
    END IF;
  END IF;

  INSERT INTO rate_limits (function_name, caller_id, blocked)
  VALUES (p_function_name, p_user_id, false);

  RETURN jsonb_build_object(
    'allowed', true,
    'counts', jsonb_build_object('hour', hourly_count + 1, 'day', daily_count + 1, 'month', monthly_count + 1),
    'estimated_spend', (monthly_count + 1) * config.monthly_cost_estimate
  );
END;
$function$;

-- rate_limit_client_key() -- REAL body, verbatim from the forward
-- migration (D3: Vault + HMAC, STABLE not IMMUTABLE).
create or replace function rate_limit_client_key(p_ip text) returns uuid
 language plpgsql stable as $function$
DECLARE
  v_salt text;
  v_hash bytea;
  v_hex  text;
BEGIN
  IF p_ip IS NULL OR btrim(p_ip) = '' THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO v_salt
  FROM vault.decrypted_secrets
  WHERE name = 'rate_limit_ip_salt';

  IF v_salt IS NULL THEN
    RETURN NULL;
  END IF;

  v_hash := extensions.hmac(btrim(p_ip), v_salt, 'sha256');
  v_hex  := encode(v_hash, 'hex');

  RETURN (
    substr(v_hex, 1, 8) || '-' ||
    substr(v_hex, 9, 4) || '-' ||
    '4' || substr(v_hex, 14, 3) || '-' ||
    'a' || substr(v_hex, 18, 3) || '-' ||
    substr(v_hex, 21, 12)
  )::uuid;
END;
$function$;

-- register_partner() -- the fixed version from this migration, verbatim
-- (agreement/meta_lead comments trimmed for harness brevity; the SQL
-- itself is unchanged from the forward migration file, including the D1
-- v_rl_ip derivation and the D4 per-client test-bucket key).
create or replace function register_partner(p_agent_type text, p_first_name text, p_last_name text, p_email text, p_phone text default null::text, p_company text default null::text, p_website text default null::text, p_service_area text default null::text, p_referred_by_note text default null::text, p_recruit_code text default null::text, p_metadata jsonb default '{}'::jsonb, p_photo_url text default null::text, p_utm_source text default null::text, p_utm_medium text default null::text, p_utm_campaign text default null::text, p_utm_content text default null::text, p_is_test boolean default false, p_fbclid text default null::text, p_li_fat_id text default null::text, p_funnel_id text default null::text, p_meta_lead_id text default null::text)
 returns jsonb language plpgsql as $function$
DECLARE
  v_email        text;
  v_recruiter_id uuid;
  v_constraint   text;
  v_row          referral_agents%ROWTYPE;
  v_rate         jsonb;
  v_rate_global  jsonb;
  v_headers      jsonb;
  v_ip           text;
  v_rl_ip        text;
  v_ua           text;
  v_is_test      boolean;
  v_probe_is_test boolean;
  v_client_key   uuid;
  v_is_service_role boolean;
  v_meta_lead_id text;
  v_status       text;
  v_agreement_version_to_write text;
  v_agreement_accepted_at      timestamptz;
  v_agreement_attestation      jsonb;
  v_agreement_version CONSTANT text := 'v3-2026-09';
BEGIN
  v_is_service_role := COALESCE(auth.role() = 'service_role', false);

  BEGIN
    v_headers := current_setting('request.headers', true)::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  v_ip := COALESCE(
    NULLIF(split_part(v_headers->>'x-forwarded-for', ',', 1), ''),
    v_headers->>'cf-connecting-ip',
    v_headers->>'x-real-ip'
  );
  v_ua := v_headers->>'user-agent';

  v_rl_ip := COALESCE(
    NULLIF(btrim(v_headers->>'cf-connecting-ip'), ''),
    NULLIF(btrim(v_headers->>'x-real-ip'), ''),
    NULLIF(btrim(reverse(split_part(reverse(COALESCE(v_headers->>'x-forwarded-for','')), ',', 1))), '')
  );
  IF v_rl_ip LIKE '%:%' THEN
    BEGIN
      v_rl_ip := network(set_masklen(v_rl_ip::inet, 64))::text;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  IF v_is_service_role THEN
    v_rate := check_rate_limit('register_partner_service_role', auth.uid());
    IF NOT COALESCE((v_rate->>'allowed')::boolean, false) THEN
      RAISE EXCEPTION 'rate_limited: %', COALESCE(v_rate->>'reason', 'register_partner rate limit exceeded');
    END IF;
  ELSE
    v_probe_is_test := is_test_email(lower(btrim(COALESCE(p_email, ''))));
    v_client_key     := rate_limit_client_key(v_rl_ip);

    IF v_probe_is_test THEN
      v_rate := check_rate_limit('register_partner_test', v_client_key);
      IF NOT COALESCE((v_rate->>'allowed')::boolean, false) THEN
        RAISE EXCEPTION 'rate_limited: %', COALESCE(v_rate->>'reason', 'register_partner test-bucket rate limit exceeded');
      END IF;
    ELSE
      v_rate := check_rate_limit('register_partner', v_client_key);
      IF NOT COALESCE((v_rate->>'allowed')::boolean, false) THEN
        RAISE EXCEPTION 'rate_limited: %', COALESCE(v_rate->>'reason', 'register_partner rate limit exceeded');
      END IF;

      v_rate_global := check_rate_limit('register_partner_global', NULL);
      IF NOT COALESCE((v_rate_global->>'allowed')::boolean, false) THEN
        RAISE EXCEPTION 'rate_limited: %', COALESCE(v_rate_global->>'reason', 'register_partner rate limit exceeded');
      END IF;
    END IF;
  END IF;

  IF p_agent_type IS NULL OR p_agent_type NOT IN
     ('re_agent', 'insurance_agent', 'home_inspector', 'customer', 'adjuster', 'other') THEN
    RAISE EXCEPTION 'invalid_agent_type: %', COALESCE(p_agent_type, '(null)');
  END IF;

  v_email := lower(btrim(COALESCE(p_email, '')));
  IF btrim(COALESCE(p_first_name, '')) = '' OR btrim(COALESCE(p_last_name, '')) = '' OR v_email = '' THEN
    RAISE EXCEPTION 'missing_required_fields';
  END IF;
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR length(v_email) > 320 THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;

  IF EXISTS (SELECT 1 FROM referral_agents WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'partner_exists';
  END IF;

  v_is_test := is_test_email(v_email) OR (COALESCE(p_is_test, false) AND COALESCE(auth.role() = 'service_role', false));
  v_meta_lead_id := CASE WHEN v_is_service_role THEN NULLIF(btrim(COALESCE(p_meta_lead_id, '')), '') ELSE NULL END;
  v_status := CASE WHEN v_is_service_role THEN 'pending' ELSE 'active' END;
  v_agreement_version_to_write := CASE WHEN v_is_service_role THEN NULL ELSE v_agreement_version END;
  v_agreement_accepted_at      := CASE WHEN v_is_service_role THEN NULL ELSE now() END;
  v_agreement_attestation      := CASE WHEN v_is_service_role THEN '{}'::jsonb ELSE
    jsonb_build_object(v_agreement_version, jsonb_build_object('accepted_ip', v_ip, 'accepted_ua', v_ua, 'accepted_at', now()))
  END;

  INSERT INTO referral_agents (
    agent_type, first_name, last_name, email, phone, company, website,
    service_area, photo_url, referred_by_note, metadata,
    utm_source, utm_medium, utm_campaign, utm_content, is_test,
    status, partner_agreement_version, partner_agreement_accepted_at,
    partner_agreement_attestation, fbclid, li_fat_id, funnel_id, meta_lead_id
  ) VALUES (
    p_agent_type, btrim(p_first_name), btrim(p_last_name), v_email,
    p_phone, p_company, p_website, p_service_area, p_photo_url, p_referred_by_note,
    COALESCE(p_metadata, '{}'::jsonb), p_utm_source, p_utm_medium, p_utm_campaign, p_utm_content,
    v_is_test, v_status, v_agreement_version_to_write, v_agreement_accepted_at,
    v_agreement_attestation, p_fbclid, p_li_fat_id, p_funnel_id, v_meta_lead_id
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('id', v_row.id, 'unique_code', v_row.unique_code, 'recruit_code', v_row.recruit_code);
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION 'partner_exists_or_dup: %', v_constraint;
END;
$function$;

-- === seed config (small numbers, deliberately tighter than production so
--     the test runs fast) ======================================================

insert into rate_limit_config (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap)
values
  ('register_partner', 10, 3, 100, true, 0, 0),         -- per-client: 3/day
  ('register_partner_test', 100, 10, 1000, true, 0, 0), -- test bucket: 10/day PER CLIENT (D4)
  ('register_partner_global', 100, 5, 1000, true, 0, 0) -- global ceiling: 5/day
;

-- === 1. per-client isolation: 3 real signups from IP-A succeed, 4th fails ===

select set_config('request.headers', '{"x-forwarded-for":"10.0.0.1"}', false);
select register_partner('re_agent','A1','Real','a1@realtor-example.com');
select register_partner('re_agent','A2','Real','a2@realtor-example.com');
select register_partner('re_agent','A3','Real','a3@realtor-example.com');

do $$
begin
  begin
    perform register_partner('re_agent','A4','Real','a4@realtor-example.com');
    raise exception 'TEST FAIL (step 1): 4th signup from IP-A should have been rate-limited';
  exception when others then
    if sqlerrm not like 'rate_limited:%' then
      raise exception 'TEST FAIL (step 1): wrong error for 4th IP-A signup: %', sqlerrm;
    end if;
  end;
end $$;

do $$
declare v_global_day int;
begin
  select count(*) into v_global_day from rate_limits
   where function_name = 'register_partner_global' and not blocked;
  if v_global_day <> 3 then
    raise exception 'TEST FAIL (step 1 check): expected 3 successful register_partner_global rows, got %', v_global_day;
  end if;
end $$;

-- === 2. a different real client (IP-B) is unaffected by IP-A's cap =========

select set_config('request.headers', '{"x-forwarded-for":"10.0.0.2"}', false);
select register_partner('insurance_agent','B1','Real','b1@insurer-example.com');

do $$
declare v_global_day int;
begin
  select count(*) into v_global_day from rate_limits
   where function_name = 'register_partner_global' and not blocked;
  if v_global_day <> 4 then
    raise exception 'TEST FAIL (step 2): expected register_partner_global day count 4 after IP-B''s signup, got %', v_global_day;
  end if;
end $$;

-- === 3. test traffic never touches the real budget, AND is per-client (D4) ==

select set_config('request.headers', '{"x-forwarded-for":"10.0.0.1"}', false);
do $$
declare i int;
begin
  for i in 1..6 loop
    perform register_partner('re_agent', 'T'||i, 'Test', 'qa'||i||'@otterquote-internal.test');
  end loop;
end $$;

do $$
declare v_test_day int;
begin
  select count(*) into v_test_day from rate_limits where function_name = 'register_partner_test' and not blocked;
  if v_test_day <> 6 then
    raise exception 'TEST FAIL (step 3): expected 6 successful register_partner_test rows, got %', v_test_day;
  end if;
end $$;

do $$
declare v_client_day int; v_global_day int;
begin
  select count(*) into v_client_day from rate_limits where function_name = 'register_partner' and not blocked;
  select count(*) into v_global_day from rate_limits where function_name = 'register_partner_global' and not blocked;
  if v_client_day <> 4 then
    raise exception 'TEST FAIL (step 3 isolation): register_partner (real, all clients combined) day count should still be 4 (3 IP-A + 1 IP-B), got %', v_client_day;
  end if;
  if v_global_day <> 4 then
    raise exception 'TEST FAIL (step 3 isolation): register_partner_global day count should still be 4, got %', v_global_day;
  end if;
end $$;

-- D4: IP-A's test bucket (limit 10/day) already has 6. 4 more from IP-A
-- exhaust it (10/10); an 11th from IP-A must be refused, while a test
-- signup from a DIFFERENT client (IP-B) in the SAME instant must still
-- succeed -- proving the test bucket is per-client, not shared.
do $$
declare i int;
begin
  for i in 7..10 loop
    perform register_partner('re_agent', 'T'||i, 'Test', 'qa'||i||'@otterquote-internal.test');
  end loop;
end $$;

do $$
begin
  begin
    perform register_partner('re_agent', 'T11', 'Test', 'qa11@otterquote-internal.test');
    raise exception 'TEST FAIL (step 3 D4): 11th test signup from IP-A should have hit its own per-client test-bucket limit';
  exception when others then
    if sqlerrm not like 'rate_limited:%' then
      raise exception 'TEST FAIL (step 3 D4): wrong error for 11th IP-A test signup: %', sqlerrm;
    end if;
  end;
end $$;

select set_config('request.headers', '{"x-forwarded-for":"10.0.0.2"}', false);
select register_partner('re_agent', 'TB1', 'Test', 'qa-b1@otterquote-internal.test');  -- must succeed: IP-B's OWN test bucket, unaffected by IP-A's exhaustion

select set_config('request.headers', '{"x-forwarded-for":"10.0.0.1"}', false);

-- === 4. global ceiling still catches many-IP abuse (real-time RAISE) ========
-- (D2: alert delivery for this bucket now lives in platform-health-check's
-- fireAlert() path, not in a SQL insert -- exercised in that function's own
-- test/CI, not this harness. This step only re-confirms the BLOCK itself,
-- which is unchanged and still synchronous.)

select set_config('request.headers', '{"x-forwarded-for":"10.0.0.3"}', false);
select register_partner('home_inspector','C1','Real','c1@inspector-example.com'); -- pushes global to 5/5

select set_config('request.headers', '{"x-forwarded-for":"10.0.0.4"}', false);
do $$
begin
  begin
    perform register_partner('home_inspector','D1','Real','d1@inspector-example.com');
    raise exception 'TEST FAIL (step 4): 6th distinct-IP real signup should have hit the global ceiling';
  exception when others then
    if sqlerrm not like 'rate_limited:%' then
      raise exception 'TEST FAIL (step 4): wrong error for global-ceiling signup: %', sqlerrm;
    end if;
  end;
end $$;

-- === 5. idempotency: re-applying the config upserts changes nothing =======

insert into rate_limit_config (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap)
values
  ('register_partner', 10, 3, 100, true, 0, 0),
  ('register_partner_test', 100, 10, 1000, true, 0, 0),
  ('register_partner_global', 100, 5, 1000, true, 0, 0)
on conflict (function_name) do update set
  max_per_hour = excluded.max_per_hour, max_per_day = excluded.max_per_day,
  max_per_month = excluded.max_per_month, enabled = excluded.enabled;

do $$
declare v_rows int;
begin
  select count(*) into v_rows from rate_limit_config
   where function_name in ('register_partner','register_partner_test','register_partner_global');
  if v_rows <> 3 then
    raise exception 'TEST FAIL (step 5): expected exactly 3 config rows after re-apply, got %', v_rows;
  end if;
end $$;

-- === 7 (D1). SPOOFING NEGATIVE CONTROL =====================================
-- cf-connecting-ip fixed at 198.51.100.9 for all 21 calls; x-forwarded-for's
-- LEFT-MOST hop (fully attacker-controlled) changes on EVERY call. Give this
-- IP its own generous per-client allowance so the assertion is about
-- bucketing, not about colliding with steps 1-4's counts.

insert into rate_limit_config (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap)
values ('register_partner', 10, 3, 100, true, 0, 0)
on conflict (function_name) do update set max_per_day = 3;
-- (limit already 3/day globally-per-key; this IP is fresh so it gets its own 3)

-- step 4 already drove register_partner_global to its 5/5 ceiling; raise it
-- here so step 7's assertions are about per-client bucketing, not a
-- collision with the (already-tested) global ceiling from step 4.
update rate_limit_config set max_per_day = 100 where function_name = 'register_partner_global';

do $$
declare i int; v_key bigint;
begin
  for i in 1..3 loop
    perform set_config('request.headers',
      jsonb_build_object('cf-connecting-ip', '198.51.100.9', 'x-forwarded-for',
        format('203.0.113.%s, 198.51.100.9', i))::text, false);
    perform register_partner('re_agent', 'Spoof'||i, 'Real', 'spoof'||i||'@realtor-example.com');
  end loop;

  -- 4th call: yet another forged left-most XFF hop. If the bug this
  -- negative control targets (keying on XFF's left-most, caller-supplied
  -- hop) were still present, this would land in a brand-new bucket and
  -- succeed. With cf-connecting-ip fixed, it must be refused.
  perform set_config('request.headers',
    jsonb_build_object('cf-connecting-ip', '198.51.100.9', 'x-forwarded-for', '9.9.9.9, 198.51.100.9')::text, false);
  begin
    perform register_partner('re_agent', 'Spoof4', 'Real', 'spoof4@realtor-example.com');
    raise exception 'TEST FAIL (step 7 D1): a forged left-most X-Forwarded-For hop let a 4th call from the same cf-connecting-ip through -- the rate-limit key is still trusting a caller-controlled header.';
  exception when others then
    if sqlerrm not like 'rate_limited:%' then
      raise exception 'TEST FAIL (step 7 D1): wrong error: %', sqlerrm;
    end if;
  end;

  -- Confirm all 3 successful calls landed in the SAME bucket (one caller_id
  -- for this cf-connecting-ip), not 3 different ones.
  select count(distinct caller_id) into v_key from rate_limits
   where function_name = 'register_partner' and not blocked
     and called_at > now() - interval '1 minute'
     and caller_id = (select rate_limit_client_key('198.51.100.9'));
  if v_key <> 1 then
    raise exception 'TEST FAIL (step 7 D1): expected exactly 1 distinct bucket key for cf-connecting-ip 198.51.100.9, got %', v_key;
  end if;
end $$;

do $$
begin
  raise notice 'gh2223 rate-limit fix: ALL TEST STEPS PASSED (including D1 spoofing negative control)';
end $$;

rollback;
