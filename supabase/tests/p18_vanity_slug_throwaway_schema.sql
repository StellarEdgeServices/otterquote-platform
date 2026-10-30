-- P18 throwaway Postgres stub of the production objects the proof touches (NEVER production).
-- Mirrors, as read 2026-10-30: roles, auth.uid()/auth.role()/auth.jwt(), is_admin_email(), a trimmed referral_agents with the live
-- RLS policy "Agents can update own profile" and table grants (anon SELECT; authenticated SELECT, UPDATE).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(auth.jwt() ->> 'sub', '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt() ->> 'role' $$;
CREATE FUNCTION public.is_admin_email() RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public','pg_temp'
  AS $$ SELECT (auth.jwt() ->> 'email') IN ('dustinstohler1@gmail.com','dustin@otterquote.com') $$;
CREATE TABLE public.referral_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid, email text NOT NULL UNIQUE, unique_code text NOT NULL UNIQUE, recruit_code text UNIQUE,
  status text NOT NULL, agent_type text NOT NULL, is_test boolean NOT NULL DEFAULT false
);
ALTER TABLE public.referral_agents ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.referral_agents TO anon;
GRANT SELECT, UPDATE ON public.referral_agents TO authenticated;
GRANT ALL ON public.referral_agents TO service_role;
CREATE POLICY "Agents can update own profile" ON public.referral_agents FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "Agents can view own profile" ON public.referral_agents FOR SELECT USING (user_id = auth.uid());
INSERT INTO public.referral_agents (id, user_id, email, unique_code, status, agent_type, is_test) VALUES
 ('9bf90639-269c-41b6-9d99-153ea187b36b','fe97bbb6-6117-4147-98e4-be28e9f78bda','a@example.test','JFY5GZOD','active','re_agent',true),
 ('80219b53-6f78-46ef-9236-2c2802faa9ea','24bd2fbb-8ec3-44bc-8495-5c0adaef1f3c','b@example.test','ZN73R8GY','active','re_agent',true);
-- platform_settings(key text, value jsonb, updated_at), as read 2026-10-30; no partner_attribution_window_days row today (PR #3226 seeds 90)
CREATE TABLE public.platform_settings (key text PRIMARY KEY, value jsonb, updated_at timestamptz DEFAULT now());
-- Supabase default privileges: new public tables / sequences are open to anon + authenticated until revoked (reproduced so the REVOKEs are tested)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
