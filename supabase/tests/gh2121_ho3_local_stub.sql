-- gh-2121 HO-3 (PR #2226 REVIEW D15): minimal stand-ins for the Supabase
-- objects the HO-3 migration depends on, so the migration and
-- gh2121_ho3_lead_token_proof.sql can be run against a THROWAWAY local
-- PostgreSQL (16+) with no Supabase stack. NEVER run this against a real
-- project: it creates roles, schemas and tables that already exist there.
--
-- Local run (throwaway cluster; see the proof file's header for the exact
-- commands):
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/gh2121_ho3_local_stub.sql
--   psql -v ON_ERROR_STOP=1 -f supabase/migrations/20260926190000_gh2121_ho3_lead_measurement_noauth.sql
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/gh2121_ho3_lead_token_proof.sql
--
-- What it mirrors from the live project (yeszghaspzwwstvsrioa, read by SELECT
-- on 2026-09-26): pgcrypto installed in schema `extensions`; the default ACL
-- on schema public that grants anon/authenticated/service_role ALL on every
-- new table (the reason D1 existed); the columns of public.leads the HO-3
-- functions read; rate_limit_config; storage.buckets with its limit columns;
-- is_admin_email().

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text,
  phone text,
  is_synthetic boolean,
  created_at timestamptz default now()
);
alter table public.leads enable row level security;
drop policy if exists "Allow anonymous inserts" on public.leads;
create policy "Allow anonymous inserts" on public.leads for insert to anon, authenticated with check (true);

create table if not exists public.rate_limit_config (
  function_name text primary key,
  max_per_hour integer not null default 10,
  max_per_day integer not null default 50,
  max_per_month integer not null default 500,
  enabled boolean default true,
  notes text
);

create or replace function public.is_admin_email() returns boolean language sql stable as $$ select false $$;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
