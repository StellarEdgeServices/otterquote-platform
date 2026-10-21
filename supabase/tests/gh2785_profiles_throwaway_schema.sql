-- gh-2785: THROWAWAY schema for gh2785_profiles_freeze_proof.sql. Never applied anywhere but a scratch Postgres.
-- Shape mirrors production public.profiles as read 2026-10-14 (CTO RUN 67, read-only): baseline columns (v000) with
-- role text NOT NULL DEFAULT 'homeowner' + profiles_role_check, is_test boolean NOT NULL DEFAULT false, table-level
-- GRANT ALL to anon, authenticated and service_role (production: anon and authenticated each hold INSERT, SELECT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES, TRIGGER), RLS on, the live policies as in v000 baseline lines 3712-3720 (own-row DELETE, INSERT and UPDATE
-- TO public, SELECT TO authenticated), the live BEFORE INSERT trigger profiles_set_is_test_for_internal_domain (gh-1961), plus the live
-- sync_contractor_profile_role() (SECURITY DEFINER, from 20260508005555_v6) on a minimal contractors stub.
-- NOT LOADED: the other profiles columns, the other policies and triggers, auth.users.
\set ON_ERROR_STOP on
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $f$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $f$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $f$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE public.profiles (
  id uuid NOT NULL PRIMARY KEY,
  full_name text, email text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  phone text,
  role text DEFAULT 'homeowner' NOT NULL,
  is_test boolean DEFAULT false NOT NULL,
  CONSTRAINT profiles_role_check CHECK (role = ANY (ARRAY['homeowner','contractor']))
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.profiles TO anon, authenticated, service_role;
CREATE POLICY profiles_user_read ON public.profiles AS PERMISSIVE FOR SELECT TO authenticated USING ((id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can delete own profile" ON public.profiles AS PERMISSIVE FOR DELETE TO public USING ((id = ( SELECT auth.uid() AS uid)));
CREATE POLICY profiles_user_insert ON public.profiles AS PERMISSIVE FOR INSERT TO public WITH CHECK ((id = ( SELECT auth.uid() AS uid)));
CREATE POLICY profiles_user_update ON public.profiles AS PERMISSIVE FOR UPDATE TO public USING ((id = ( SELECT auth.uid() AS uid))) WITH CHECK ((id = ( SELECT auth.uid() AS uid)));

-- live gh-1961 trigger, byte-equivalent body (20260927183251)
create or replace function public.set_is_test_for_internal_test_domain()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if NEW.email is not null and lower(NEW.email) like '%@otterquote-internal.test' then NEW.is_test := true; end if;
  return NEW;
end; $fn$;
create trigger profiles_set_is_test_for_internal_domain before insert on public.profiles for each row execute function public.set_is_test_for_internal_test_domain();

-- handle_new_user() shape (live body, 20261007201941): SECURITY DEFINER insert with column defaults
create or replace function public.proof_handle_new_user(p_id uuid, p_email text) returns void
language plpgsql security definer set search_path = public, pg_temp as $f$
begin insert into public.profiles (id, email, full_name, created_at, updated_at) values (p_id, p_email, null, now(), now()) on conflict (id) do nothing; end $f$;
GRANT EXECUTE ON FUNCTION public.proof_handle_new_user(uuid, text) TO authenticated;

CREATE TABLE public.contractors (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid NOT NULL);
ALTER TABLE public.contractors ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.contractors TO authenticated, service_role;
CREATE POLICY contractors_ins ON public.contractors FOR INSERT TO authenticated WITH CHECK (user_id = (select auth.uid()));

CREATE OR REPLACE FUNCTION sync_contractor_profile_role()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE profiles SET role = 'contractor', updated_at = NOW()
  WHERE id = NEW.user_id AND (role IS NULL OR role != 'contractor');
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_sync_contractor_profile_role AFTER INSERT ON contractors FOR EACH ROW EXECUTE FUNCTION sync_contractor_profile_role();
