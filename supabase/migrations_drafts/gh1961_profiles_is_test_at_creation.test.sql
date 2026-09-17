-- gh-1961 test harness for gh1961_profiles_is_test_at_creation.sql
--
-- Reference/manual test -- this repo has no pgTAP or SQL test runner wired
-- into CI for supabase/migrations*/ (checked: no pgtap extension use, no
-- pg_prove, no supabase/tests directory anywhere in the tree). Run this
-- against a scratch Postgres 17 database named exactly `gh1961_test`
-- (the guard immediately below refuses to run anywhere else):
--
--   createdb -p 5433 gh1961_test   # once
--   psql -p 5433 -d gh1961_test -v ON_ERROR_STOP=1 \
--     -f supabase/migrations_drafts/gh1961_profiles_is_test_at_creation.test.sql
--
-- Fix round (PR #2002 review comment 5706433778) rewrote this file to
-- actually install the REAL production function/trigger bodies this
-- migration interacts with -- pulled live via `pg_get_functiondef` against
-- yeszghaspzwwstvsrioa, not paraphrased or invented -- instead of only
-- inserting directly into a bare `profiles` table. Specifically this file
-- now installs: `handle_new_user()` + `on_auth_user_created` (AFTER INSERT
-- ON auth.users), `contractors_freeze_privileged_columns()` + its BEFORE
-- INSERT OR UPDATE trigger, and `sync_contractor_profile_role()` + its
-- AFTER INSERT trigger -- so the ordering claim in the forward migration's
-- own header (this migration's contractors trigger fires AFTER the real
-- freeze trigger, alphabetically) is proven against the real object, not
-- assumed.
--
-- It asserts, in order:
--   0. safety guard -- refuses to run against anything but the scratch DB
--   1. NEGATIVE CONTROL, before the migration is applied: an internal-domain
--      homeowner signup and an internal-domain contractor signup (inserted
--      as role `authenticated`, matching the real app) both land
--      is_test = false, and the #1763 cross-table DISAGREEMENT_SQL predicate
--      (byte-for-byte the same query scripts/is-test-cross-table-check.py
--      and the daily prod guard run) returns 0 rows.
--   2. the migration under test is applied
--   3. an @otterquote-internal.test homeowner signup (via the real
--      auth.users -> handle_new_user() -> profiles path) lands is_test=true
--   4. mixed-case domain -> true; lookalike (non-suffix) domains -> false
--      (negative controls); a real domain -> false (negative control);
--      a leading/trailing-space email -> false (documented gap, see below)
--   5. an internal-domain CONTRACTOR signup (authenticated role, exercising
--      the real contractors_freeze_privileged_columns trigger first, then
--      this migration's new trigger) lands BOTH profiles.is_test=true AND
--      contractors.is_test=true -- proving the alphabetical-ordering fix
--      actually overrides the freeze trigger's forced false, not merely
--      documenting the assumption that it will
--   6. the #1763 DISAGREEMENT_SQL predicate still returns 0 rows after that
--      internal contractor insert (this is what review finding B1 requires)
--   7. a real-domain contractor signup stays is_test=false on both tables
--      (negative control)
--   8. never-unsets: an explicit is_test=true on a non-matching email/role
--      survives on both tables
--   9. idempotency: the migration is re-applied a second time; exit 0,
--      exactly one copy of each new trigger survives, behavior unchanged
--
-- Known gap, documented rather than silently passed over: the trigger
-- matches `lower(NEW.email) like '%@otterquote-internal.test'`, which does
-- NOT trim whitespace. A padded address like ' pad@otterquote-internal.test '
-- (leading/trailing space) is asserted to land is_test=false here -- GoTrue
-- does not store padded addresses in practice, so this is recorded as
-- harmless, not fixed.

\set ON_ERROR_STOP 1

-- === 0. Safety guard =========================================================
-- gh-1961 review finding B2 (blocking): the previous version of this file
-- ran `drop schema if exists public cascade` unconditionally, which would
-- destroy a real database if this script were ever run with a stray
-- PGHOST/PGSERVICE/PGDATABASE pointed at one. Refuse outright unless the
-- connected database is exactly the throwaway scratch DB this file expects.
do $$
begin
  if current_database() <> 'gh1961_test' then
    raise exception
      'gh1961 test harness: refusing to run against database %I -- this '
      'script DROPs and rebuilds the auth/public schemas and must only ever '
      'run against a scratch database literally named gh1961_test. Create '
      'one (createdb -p 5433 gh1961_test) and reconnect.', current_database();
  end if;
end $$;

begin;

drop schema if exists auth cascade;
create schema auth;
create table auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text,
  raw_user_meta_data  jsonb not null default '{}'::jsonb
);

-- Minimal stand-in for GoTrue's auth.jwt() -- contractors_freeze_privileged_columns
-- calls `auth.jwt() ->> 'email'` to exempt the admin account. Returns an
-- empty object here (no email claim), which is exactly the "authenticated,
-- non-admin" caller shape this harness needs to exercise.
create or replace function auth.jwt() returns jsonb
language sql stable
as $$ select '{}'::jsonb $$;

drop schema if exists public cascade;
create schema public;

create table public.profiles (
  id            uuid primary key,
  email         text,
  full_name     text,
  address_state text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  role          text not null default 'homeowner',
  is_test       boolean not null default false
);

create table public.contractors (
  id                              uuid primary key default gen_random_uuid(),
  user_id                         uuid not null,
  company_name                    text,
  status                          text default 'pending_approval',
  template_review_role            text,
  verified                        boolean default false,
  rating                          numeric,
  review_count                    integer default 0,
  license_verified                boolean default false,
  license_verified_at             timestamptz,
  insurance_verified               boolean default false,
  insurance_verified_at           timestamptz,
  insurance_verification_sent_at  timestamptz,
  insurance_verification_email    text,
  approved_at                     timestamptz,
  rejected_at                     timestamptz,
  rejection_reason                text,
  cert_status                     text,
  legacy_pre_approval             boolean default false,
  needs_cpa_reattestation         boolean default false,
  admin_notes                     text,
  is_test                         boolean not null default false,
  has_payment_method              boolean default false,
  stripe_payment_method_id        text,
  stripe_payment_method_last4     text,
  created_at                      timestamptz not null default now()
);

-- --- The REAL handle_new_user(), verbatim from pg_get_functiondef() against
--     yeszghaspzwwstvsrioa (2026-09-16), not paraphrased.
create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, address_state, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NULL),
    'IN',
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- --- The REAL contractors_freeze_privileged_columns(), verbatim from
--     pg_get_functiondef() against yeszghaspzwwstvsrioa (2026-09-16). Not
--     SECURITY DEFINER in production, so not marked so here either --
--     matching that means this harness's role-switch to `authenticated`
--     below actually exercises the `current_user <> 'authenticated'` branch
--     exactly as production does.
create or replace function public.contractors_freeze_privileged_columns()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
BEGIN
  -- Only constrain direct end-user (authenticated) writes. service_role (Edge Functions / cron)
  -- and SECURITY DEFINER system triggers run as a non-'authenticated' role => exempt.
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  -- Admin account is exempt (mirrors the existing admin_update_contractors policy).
  IF coalesce(auth.jwt() ->> 'email', '') = 'dustinstohler1@gmail.com' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status                         := 'pending_approval';
    NEW.template_review_role           := NULL;
    NEW.verified                       := false;
    NEW.rating                         := NULL;
    NEW.review_count                   := 0;
    NEW.license_verified               := false;
    NEW.license_verified_at            := NULL;
    NEW.insurance_verified             := false;
    NEW.insurance_verified_at          := NULL;
    NEW.insurance_verification_sent_at := NULL;
    NEW.insurance_verification_email   := NULL;
    NEW.approved_at                    := NULL;
    NEW.rejected_at                    := NULL;
    NEW.rejection_reason               := NULL;
    NEW.cert_status                    := NULL;
    NEW.legacy_pre_approval            := false;
    NEW.needs_cpa_reattestation        := false;
    NEW.admin_notes                    := NULL;
    NEW.is_test                        := false;
    NEW.has_payment_method             := false;      -- gh-1425 path 1
    NEW.stripe_payment_method_id       := NULL;       -- gh-1425 path 1
    NEW.stripe_payment_method_last4    := NULL;       -- gh-1425 path 1
    RETURN NEW;
  END IF;

  -- UPDATE: pin every privileged column to its stored value (silently ignore change attempts).
  NEW.status                         := OLD.status;
  NEW.template_review_role           := OLD.template_review_role;
  NEW.verified                       := OLD.verified;
  NEW.rating                         := OLD.rating;
  NEW.review_count                   := OLD.review_count;
  NEW.license_verified               := OLD.license_verified;
  NEW.license_verified_at            := OLD.license_verified_at;
  NEW.insurance_verified             := OLD.insurance_verified;
  NEW.insurance_verified_at          := OLD.insurance_verified_at;
  NEW.insurance_verification_sent_at := OLD.insurance_verification_sent_at;
  NEW.insurance_verification_email   := OLD.insurance_verification_email;
  NEW.approved_at                    := OLD.approved_at;
  NEW.rejected_at                    := OLD.rejected_at;
  NEW.rejection_reason               := OLD.rejection_reason;
  NEW.cert_status                    := OLD.cert_status;
  NEW.legacy_pre_approval            := OLD.legacy_pre_approval;
  NEW.needs_cpa_reattestation        := OLD.needs_cpa_reattestation;
  NEW.admin_notes                    := OLD.admin_notes;
  NEW.is_test                        := OLD.is_test;
  NEW.has_payment_method             := OLD.has_payment_method;              -- gh-1425 path 1
  NEW.stripe_payment_method_id       := OLD.stripe_payment_method_id;        -- gh-1425 path 1
  NEW.stripe_payment_method_last4    := OLD.stripe_payment_method_last4;     -- gh-1425 path 1
  RETURN NEW;
END;
$function$;

create trigger contractors_freeze_privileged_columns
  before insert or update on public.contractors
  for each row execute function public.contractors_freeze_privileged_columns();

-- --- The REAL sync_contractor_profile_role(), verbatim from
--     pg_get_functiondef() against yeszghaspzwwstvsrioa (2026-09-16).
create or replace function public.sync_contractor_profile_role()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  UPDATE profiles
  SET role = 'contractor',
      updated_at = NOW()
  WHERE id = NEW.user_id
    AND (role IS NULL OR role != 'contractor');
  RETURN NEW;
END;
$function$;

create trigger trg_sync_contractor_profile_role
  after insert on public.contractors
  for each row execute function public.sync_contractor_profile_role();

-- Role named literally `authenticated` so current_user reads 'authenticated'
-- inside the real freeze trigger (it checks current_user <> 'authenticated'
-- by that exact string), exactly as it does for a real end-user request in
-- production. Not a login role; membership is enough for SET ROLE from a
-- superuser session. Roles are cluster-wide, not per-database, so this
-- script never DROPs a pre-existing `authenticated` role (another scratch
-- database on the same shared local cluster may already own one and depend
-- on it) -- it only creates one if none exists yet, and only grants on
-- objects inside THIS database.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;
grant usage on schema public to authenticated;
grant usage on schema auth to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.contractors to authenticated;
grant execute on function auth.jwt() to authenticated;

commit;

-- === #1763 cross-table disagreement predicate ===============================
-- Byte-for-byte scripts/is-test-cross-table-check.py's DISAGREEMENT_SQL --
-- the exact query the daily prod guard (edge-function-drift.yml,
-- cron 17 9 * * *) runs against production. Wrapped as a view so both the
-- "before" and "after" assertions below can select count(*) from it.
create or replace view public._gh1961_disagreements as
  select p.id as profile_id, p.is_test as profile_is_test,
         c.id as contractor_id, c.is_test as contractor_is_test, c.company_name
  from profiles p join contractors c on c.user_id = p.id
  where p.role = 'contractor' and p.is_test is distinct from c.is_test
  order by c.created_at;

-- === 1. NEGATIVE CONTROL -- before the migration under test is applied =====

do $$
declare
  v_homeowner_id uuid;
  v_contractor_user_id uuid;
  v_p_is_test boolean;
  v_c_is_test boolean;
  v_disagreements integer;
begin
  -- Internal-domain homeowner signup, through the real auth.users -> trigger path.
  insert into auth.users (email) values ('pre-migration-homeowner@otterquote-internal.test')
    returning id into v_homeowner_id;
  select is_test into v_p_is_test from public.profiles where id = v_homeowner_id;
  if v_p_is_test is distinct from false then
    raise exception 'FAIL (pre-migration control, homeowner): expected is_test=false before the migration, got %', v_p_is_test;
  end if;
  raise notice 'PASS (pre-migration control): internal-domain homeowner signup -> is_test = % (no trigger installed yet)', v_p_is_test;

  -- Internal-domain contractor signup, as role authenticated (real app path).
  insert into auth.users (email) values ('pre-migration-contractor@otterquote-internal.test')
    returning id into v_contractor_user_id;

  set role authenticated;
  insert into public.contractors (user_id, company_name) values (v_contractor_user_id, 'Pre-Migration Test Co');
  reset role;

  select p.is_test, c.is_test into v_p_is_test, v_c_is_test
  from public.profiles p join public.contractors c on c.user_id = p.id
  where p.id = v_contractor_user_id;

  if v_p_is_test is distinct from false or v_c_is_test is distinct from false then
    raise exception 'FAIL (pre-migration control, contractor): expected both false before the migration, got profile=% contractor=%', v_p_is_test, v_c_is_test;
  end if;
  raise notice 'PASS (pre-migration control): internal-domain contractor signup -> profile.is_test = %, contractors.is_test = %', v_p_is_test, v_c_is_test;

  select count(*) into v_disagreements from public._gh1961_disagreements;
  if v_disagreements <> 0 then
    raise exception 'FAIL (pre-migration control): #1763 DISAGREEMENT_SQL expected 0 rows, got %', v_disagreements;
  end if;
  raise notice 'PASS (pre-migration control): #1763 DISAGREEMENT_SQL = 0 rows before the migration';
end $$;

-- === 2. Apply the migration under test, verbatim ============================

\ir gh1961_profiles_is_test_at_creation.sql

-- === 3-8. Assertions with the migration applied ==============================

do $$
declare
  v_id uuid;
  v_user_id uuid;
  v_is_test boolean;
  v_p_is_test boolean;
  v_c_is_test boolean;
  v_disagreements integer;
begin
  -- 3. Internal test domain, real auth.users -> handle_new_user() -> profiles
  --    path -> is_test must be forced true.
  insert into auth.users (email) values ('cto33-gh1984-claimstarted@otterquote-internal.test')
    returning id into v_id;
  select is_test into v_is_test from public.profiles where id = v_id;
  if v_is_test is distinct from true then
    raise exception 'FAIL (internal-test domain, real auth path): expected is_test=true, got %', v_is_test;
  end if;
  raise notice 'PASS: cto33-gh1984-claimstarted@otterquote-internal.test (via auth.users) -> is_test = %', v_is_test;

  -- 4. Case-insensitivity, lookalikes, real domain, and the documented
  --    whitespace gap -- all via direct profiles inserts (fast path, same
  --    trigger, no need to round-trip through auth.users for every case).
  insert into public.profiles (id, email) values (gen_random_uuid(), 'Mixed.Case@OtterQuote-Internal.TEST') returning is_test into v_is_test;
  if v_is_test is distinct from true then raise exception 'FAIL (mixed-case domain): got %', v_is_test; end if;
  raise notice 'PASS: Mixed.Case@OtterQuote-Internal.TEST -> is_test = %', v_is_test;

  insert into public.profiles (id, email) values (gen_random_uuid(), 'real.homeowner@gmail.com') returning is_test into v_is_test;
  if v_is_test is distinct from false then raise exception 'FAIL (negative control, real domain): got %', v_is_test; end if;
  raise notice 'PASS (negative control): real.homeowner@gmail.com -> is_test = %', v_is_test;

  insert into public.profiles (id, email) values (gen_random_uuid(), 'someone@nototterquote-internal.test.evil.com') returning is_test into v_is_test;
  if v_is_test is distinct from false then raise exception 'FAIL (negative control, lookalike domain): got %', v_is_test; end if;
  raise notice 'PASS (negative control): someone@nototterquote-internal.test.evil.com -> is_test = %', v_is_test;

  insert into public.profiles (id, email) values (gen_random_uuid(), 'evil@sub.otterquote-internal.test') returning is_test into v_is_test;
  if v_is_test is distinct from false then raise exception 'FAIL (negative control, subdomain lookalike): got %', v_is_test; end if;
  raise notice 'PASS (negative control): evil@sub.otterquote-internal.test -> is_test = %', v_is_test;

  insert into public.profiles (id, email) values (gen_random_uuid(), 'evil@xotterquote-internal.test') returning is_test into v_is_test;
  if v_is_test is distinct from false then raise exception 'FAIL (negative control, prefix lookalike): got %', v_is_test; end if;
  raise notice 'PASS (negative control): evil@xotterquote-internal.test -> is_test = %', v_is_test;

  -- Documented gap, not a defect: the trigger does not trim(); a padded
  -- address is asserted false here (GoTrue does not store padded emails).
  insert into public.profiles (id, email) values (gen_random_uuid(), ' pad@otterquote-internal.test ') returning is_test into v_is_test;
  if v_is_test is distinct from false then raise exception 'FAIL (documented gap, padded email): expected false, got %', v_is_test; end if;
  raise notice 'PASS (documented gap, expected false): '' pad@otterquote-internal.test '' -> is_test = % (no trim(); harmless, GoTrue never stores padded addresses)', v_is_test;

  insert into public.profiles (id, email) values (gen_random_uuid(), null) returning is_test into v_is_test;
  if v_is_test is distinct from false then raise exception 'FAIL (null email): got %', v_is_test; end if;
  raise notice 'PASS (null email): is_test = %', v_is_test;

  -- Never-unsets: explicit caller-supplied true on a non-matching email survives.
  insert into public.profiles (id, email, is_test) values (gen_random_uuid(), 'fixture@example.com', true) returning is_test into v_is_test;
  if v_is_test is distinct from true then raise exception 'FAIL (never-unsets, profiles): got %', v_is_test; end if;
  raise notice 'PASS (never-unsets, profiles): caller-supplied is_test=true on non-matching email survives -> is_test = %', v_is_test;

  -- 5+6. THE B1 FIX: internal-domain CONTRACTOR signup, as role authenticated,
  --      through the real freeze trigger AND this migration's new trigger.
  insert into auth.users (email) values ('ctr-probe@otterquote-internal.test') returning id into v_user_id;
  select is_test into v_p_is_test from public.profiles where id = v_user_id;
  if v_p_is_test is distinct from true then
    raise exception 'FAIL (contractor path, profile half): expected profiles.is_test=true, got %', v_p_is_test;
  end if;

  set role authenticated;
  insert into public.contractors (user_id, company_name) values (v_user_id, 'ctr-probe Test Roofing LLC');
  reset role;

  select is_test into v_c_is_test from public.contractors where user_id = v_user_id;
  if v_c_is_test is distinct from true then
    raise exception 'FAIL (B1 fix): expected contractors.is_test=true after contractors_freeze_privileged_columns (forces false) then contractors_zz_inherit_profile_is_test (should override to true) both fire on the same INSERT -- got contractors.is_test=%. This means the alphabetical trigger-ordering assumption did NOT hold as expected.', v_c_is_test;
  end if;
  raise notice 'PASS (B1 fix, proves alphabetical trigger ordering empirically): internal contractor signup -> profiles.is_test = %, contractors.is_test = % (freeze trigger set false first, this migration''s trigger overrode it to true second)', v_p_is_test, v_c_is_test;

  select count(*) into v_disagreements from public._gh1961_disagreements;
  if v_disagreements <> 0 then
    raise exception 'FAIL (B1 fix): #1763 DISAGREEMENT_SQL expected 0 rows after the internal contractor insert, got %', v_disagreements;
  end if;
  raise notice 'PASS (B1 fix): #1763 DISAGREEMENT_SQL = 0 rows after the internal contractor insert (this is what the daily prod guard checks)';

  -- 7. Real-domain contractor signup stays false on both tables (negative control).
  insert into auth.users (email) values ('real.contractor@gmail.com') returning id into v_user_id;
  set role authenticated;
  insert into public.contractors (user_id, company_name) values (v_user_id, 'Real Roofing Co');
  reset role;
  select p.is_test, c.is_test into v_p_is_test, v_c_is_test
  from public.profiles p join public.contractors c on c.user_id = p.id where p.id = v_user_id;
  if v_p_is_test is distinct from false or v_c_is_test is distinct from false then
    raise exception 'FAIL (negative control, real contractor): expected both false, got profile=% contractor=%', v_p_is_test, v_c_is_test;
  end if;
  raise notice 'PASS (negative control): real-domain contractor signup -> profile.is_test = %, contractors.is_test = %', v_p_is_test, v_c_is_test;

  select count(*) into v_disagreements from public._gh1961_disagreements;
  if v_disagreements <> 0 then
    raise exception 'FAIL (negative control): #1763 DISAGREEMENT_SQL expected 0 rows, got %', v_disagreements;
  end if;

  -- 8. Never-unsets on contractors: a service-role seed (current_user <>
  --    'authenticated', so the freeze trigger's INSERT branch is skipped
  --    entirely) supplying is_test=true on a non-internal email must survive.
  insert into auth.users (email) values ('service-seed@example.com') returning id into v_user_id;
  insert into public.contractors (user_id, company_name, is_test) values (v_user_id, 'Service Seed Co', true);
  select is_test into v_c_is_test from public.contractors where user_id = v_user_id;
  if v_c_is_test is distinct from true then
    raise exception 'FAIL (never-unsets, contractors): expected caller-supplied is_test=true to survive, got %', v_c_is_test;
  end if;
  raise notice 'PASS (never-unsets, contractors): service-role-supplied is_test=true survives -> is_test = %', v_c_is_test;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

-- === 9. Idempotency: re-apply the migration a second time ==================

\ir gh1961_profiles_is_test_at_creation.sql

do $$
declare
  v_trigger_count integer;
  v_id uuid;
  v_is_test boolean;
begin
  select count(*) into v_trigger_count from pg_trigger
  where tgname in ('profiles_set_is_test_for_internal_domain', 'contractors_zz_inherit_profile_is_test');
  if v_trigger_count <> 2 then
    raise exception 'FAIL (idempotency): expected exactly 2 trigger rows (one per table) after re-applying twice, found %', v_trigger_count;
  end if;

  insert into public.profiles (id, email) values (gen_random_uuid(), 'second-apply-probe@otterquote-internal.test') returning is_test into v_is_test;
  if v_is_test is distinct from true then
    raise exception 'FAIL (post-reapply): expected is_test=true after re-running the migration, got %', v_is_test;
  end if;
  raise notice 'PASS (idempotency): migration re-applied cleanly, trigger count = %, trigger still fires -> is_test = %', v_trigger_count, v_is_test;
end $$;
