-- gh2238_measurement_shape_proof.sql
-- Proof for #2238 on the CI test project (zsdvaqilfdclwosmiheh) ONLY.
-- Single rolled-back batch: BEGIN ... ROLLBACK, zero COMMIT.
--
-- The CI test project's public.claims does not have a measurement_shape
-- column yet (unlike prod, where #1410/#1411 already added it), so this
-- batch shims the column in first (rolled back with everything else) and
-- says so here, per the task brief. A `diag` temp table (granted to
-- authenticated/service_role/anon) records each step's before/after value
-- so the whole run can be read back with one final SELECT before ROLLBACK.
--
-- RUN A: negative control, pre-fix -- homeowner PATCH succeeds (the bug).
-- RUN B: with the gh-2238 guard trigger installed --
--   B1 homeowner PATCH of measurement_shape is rejected (42501)
--   B2 homeowner PATCH of an unrelated allowed column (carrier_name, same
--      "Users can update own claims" policy) still succeeds
--   B3 service_role PATCH of measurement_shape still succeeds
--
-- Raw output from the actual run (2026-09-27, via Supabase MCP execute_sql
-- on zsdvaqilfdclwosmiheh), pasted in the PR body / HANDOFF-LIVE comment:
--   RUN_A_after_homeowner_patch          -> full   (bug reproduced, no guard)
--   B1_homeowner_patch_rejected          -> "claims.measurement_shape can
--                                            only be changed by service_role
--                                            or an admin (gh-2238)"
--   B1_after_state                       -> null   (write blocked)
--   B2_homeowner_carrier_name_patch_succeeded -> "Synthetic Carrier Renamed"
--   B3_service_role_patch_succeeded      -> full   (writer path unaffected)

begin;

create temp table diag(step text, val text);
grant insert, select on diag to authenticated, service_role, anon;

-- ---- shim: CI-test claims lacks measurement_shape (prod already has it) --
alter table public.claims add column if not exists measurement_shape text;

-- ---- fixture: one synthetic is_test claim owned by a fresh homeowner uid --
-- (claims.user_id FK's to auth.users -- CI-test has no seeded user for a
-- fresh gen_random_uuid(), so a minimal auth.users row is shimmed too)
do $$
declare
  v_uid uuid := gen_random_uuid();
  v_claim_id uuid;
begin
  insert into auth.users (id) values (v_uid);

  insert into public.claims (user_id, is_test, status, carrier_name)
  values (v_uid, true, 'active', 'Synthetic Carrier')
  returning id into v_claim_id;

  perform set_config('gh2238.test_uid', v_uid::text, true);
  perform set_config('gh2238.test_claim_id', v_claim_id::text, true);
end $$;

-- =========================================================================
-- RUN A -- NEGATIVE CONTROL, before the fix (no guard trigger installed yet)
-- =========================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('gh2238.test_uid'), 'role', 'authenticated')::text,
  true);

update public.claims
   set measurement_shape = 'full'
 where id = current_setting('gh2238.test_claim_id')::uuid
   and user_id = current_setting('gh2238.test_uid')::uuid;

insert into diag select 'RUN_A_after_homeowner_patch', measurement_shape
  from public.claims where id = current_setting('gh2238.test_claim_id')::uuid;

reset role;
select set_config('request.jwt.claims', '', true);

-- reset the fixture's shape back to NULL before installing the guard
update public.claims set measurement_shape = null where id = current_setting('gh2238.test_claim_id')::uuid;

-- =========================================================================
-- Install the gh-2238 guard (verbatim body of
-- supabase/migrations/20260927133100_gh2238_measurement_shape_guard.sql)
-- =========================================================================
create or replace function public.claims_guard_measurement_shape()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  if is_admin_email() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.measurement_shape is not null then
      raise exception
        'claims.measurement_shape can only be set by service_role or an admin (gh-2238)'
        using errcode = '42501';
    end if;
  else
    if new.measurement_shape is distinct from old.measurement_shape then
      raise exception
        'claims.measurement_shape can only be changed by service_role or an admin (gh-2238)'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists claims_guard_measurement_shape on public.claims;

create trigger claims_guard_measurement_shape
  before insert or update on public.claims
  for each row
  execute function public.claims_guard_measurement_shape();

-- =========================================================================
-- RUN B -- WITH the guard installed
-- =========================================================================

-- B1: homeowner PATCH measurement_shape -> expect error (42501)
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('gh2238.test_uid'), 'role', 'authenticated')::text,
  true);

do $$
begin
  begin
    update public.claims
       set measurement_shape = 'full'
     where id = current_setting('gh2238.test_claim_id')::uuid
       and user_id = current_setting('gh2238.test_uid')::uuid;
    insert into diag values ('B1_UNEXPECTED_no_error', null);
  exception when sqlstate '42501' then
    insert into diag values ('B1_homeowner_patch_rejected', sqlerrm);
  end;
end $$;

insert into diag select 'B1_after_state', measurement_shape
  from public.claims where id = current_setting('gh2238.test_claim_id')::uuid;

-- B2: homeowner PATCH of an unrelated, allowed column -> still succeeds
update public.claims
   set carrier_name = 'Synthetic Carrier Renamed'
 where id = current_setting('gh2238.test_claim_id')::uuid
   and user_id = current_setting('gh2238.test_uid')::uuid;

insert into diag select 'B2_homeowner_carrier_name_patch_succeeded', carrier_name
  from public.claims where id = current_setting('gh2238.test_claim_id')::uuid;

reset role;

-- B3: service_role PATCH measurement_shape -> still succeeds. A real
-- service_role PostgREST call presents role:service_role in the JWT claims
-- too (not just the Postgres session role), so both are set here.
set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

update public.claims
   set measurement_shape = 'full'
 where id = current_setting('gh2238.test_claim_id')::uuid;

insert into diag select 'B3_service_role_patch_succeeded', measurement_shape
  from public.claims where id = current_setting('gh2238.test_claim_id')::uuid;

reset role;
select set_config('request.jwt.claims', '', true);

select * from diag order by step;

rollback;
