-- gh-1961 test harness for gh1961_profiles_is_test_at_creation.sql
--
-- Reference/manual test -- this repo has no pgTAP or SQL test runner wired
-- into CI for supabase/migrations*/ (checked: no pgtap extension use, no
-- pg_prove, no supabase/tests directory anywhere in the tree). Run this
-- against a scratch Postgres 17 database:
--
--   psql -p 5433 -d gh1961_test -v ON_ERROR_STOP=1 \
--     -f supabase/migrations_drafts/gh1961_profiles_is_test_at_creation.test.sql
--
-- It builds a minimal stand-in for auth.users + public.profiles (just the
-- columns this trigger touches), applies the migration under test verbatim
-- via \ir, then asserts:
--   1. an @otterquote-internal.test signup lands is_test = true
--   2. a normal/real-domain signup lands is_test = false (negative control)
--   3. an explicit is_test = true on a non-matching email is left true
--      (proves the trigger never *un*sets is_test)
-- and finally re-applies the migration a second time to prove it is
-- idempotent (CREATE OR REPLACE + DROP TRIGGER IF EXISTS / CREATE TRIGGER).

\set ON_ERROR_STOP 1

begin;

-- Minimal auth schema stand-in -- only what handle_new_user()/this trigger
-- touch. Real auth.users lives in the auth schema; profiles.id is a plain
-- FK to it in production, but no FK is needed here since this trigger
-- reads only NEW.email off the INSERT into profiles itself.
drop schema if exists auth cascade;
create schema auth;
create table auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

drop schema if exists public cascade;
create schema public;
create table public.profiles (
  id      uuid primary key,
  email   text,
  is_test boolean not null default false
);

commit;

-- Apply the migration under test, verbatim, exactly as it will be applied
-- to production.
\ir gh1961_profiles_is_test_at_creation.sql

-- === Assertions =============================================================

do $$
declare
  v_id uuid;
  v_is_test boolean;
begin
  -- 1. Internal test domain -> is_test must be forced true.
  v_id := gen_random_uuid();
  insert into public.profiles (id, email) values (v_id, 'cto33-gh1984-claimstarted@otterquote-internal.test');
  select is_test into v_is_test from public.profiles where id = v_id;
  if v_is_test is distinct from true then
    raise exception 'FAIL (internal-test domain): expected is_test=true, got %', v_is_test;
  end if;
  raise notice 'PASS: cto33-gh1984-claimstarted@otterquote-internal.test -> is_test = %', v_is_test;

  -- 1b. Case-insensitivity.
  v_id := gen_random_uuid();
  insert into public.profiles (id, email) values (v_id, 'Mixed.Case@OtterQuote-Internal.TEST');
  select is_test into v_is_test from public.profiles where id = v_id;
  if v_is_test is distinct from true then
    raise exception 'FAIL (mixed-case domain): expected is_test=true, got %', v_is_test;
  end if;
  raise notice 'PASS: Mixed.Case@OtterQuote-Internal.TEST -> is_test = %', v_is_test;

  -- 2. NEGATIVE CONTROL: a real homeowner signup on a real domain must stay
  --    false -- this is the exact defect this migration exists to fix
  --    (issuecomment-5696752753: 3 real-looking non-test-domain signups
  --    were the ones that needed to be TRUE; here we assert the opposite
  --    edge holds -- a genuinely real domain is never flipped true).
  v_id := gen_random_uuid();
  insert into public.profiles (id, email) values (v_id, 'real.homeowner@gmail.com');
  select is_test into v_is_test from public.profiles where id = v_id;
  if v_is_test is distinct from false then
    raise exception 'FAIL (negative control, real domain): expected is_test=false, got %', v_is_test;
  end if;
  raise notice 'PASS (negative control): real.homeowner@gmail.com -> is_test = %', v_is_test;

  -- 2b. A lookalike domain (not an exact suffix match) must also stay false.
  v_id := gen_random_uuid();
  insert into public.profiles (id, email) values (v_id, 'someone@nototterquote-internal.test.evil.com');
  select is_test into v_is_test from public.profiles where id = v_id;
  if v_is_test is distinct from false then
    raise exception 'FAIL (negative control, lookalike domain): expected is_test=false, got %', v_is_test;
  end if;
  raise notice 'PASS (negative control): someone@nototterquote-internal.test.evil.com -> is_test = %', v_is_test;

  -- 3. Never sets false: an explicit is_test=true on a non-matching email
  --    must survive the trigger (proves the trigger only ever forces TRUE,
  --    never overwrites a caller-supplied value back to false).
  v_id := gen_random_uuid();
  insert into public.profiles (id, email, is_test) values (v_id, 'fixture@example.com', true);
  select is_test into v_is_test from public.profiles where id = v_id;
  if v_is_test is distinct from true then
    raise exception 'FAIL (never-unsets): expected caller-supplied is_test=true to survive, got %', v_is_test;
  end if;
  raise notice 'PASS (never-unsets): caller-supplied is_test=true on non-matching email survives -> is_test = %', v_is_test;

  -- 4. NULL email must not error and must leave the column default (false).
  v_id := gen_random_uuid();
  insert into public.profiles (id, email) values (v_id, null);
  select is_test into v_is_test from public.profiles where id = v_id;
  if v_is_test is distinct from false then
    raise exception 'FAIL (null email): expected default is_test=false, got %', v_is_test;
  end if;
  raise notice 'PASS (null email): is_test = %', v_is_test;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

-- === Idempotency: re-apply the migration a second time =====================
-- Must succeed with no error, and must not change prior rows (it is a
-- BEFORE INSERT trigger -- reapplying it does not touch existing rows at
-- all; this also proves CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS
-- + CREATE TRIGGER tolerate being run twice).
\ir gh1961_profiles_is_test_at_creation.sql

do $$
declare
  v_id uuid := gen_random_uuid();
  v_is_test boolean;
begin
  insert into public.profiles (id, email) values (v_id, 'second-apply-probe@otterquote-internal.test');
  select is_test into v_is_test from public.profiles where id = v_id;
  if v_is_test is distinct from true then
    raise exception 'FAIL (post-reapply): expected is_test=true after re-running the migration, got %', v_is_test;
  end if;
  raise notice 'PASS (idempotency): migration re-applied cleanly, trigger still fires -> is_test = %', v_is_test;
end $$;
