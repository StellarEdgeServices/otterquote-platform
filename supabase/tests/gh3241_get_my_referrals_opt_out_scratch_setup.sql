-- gh-3241 scratch setup for the THROWAWAY Postgres proof. Never run against production.
-- Minimal stand-ins for what get_my_referrals() reads, with the live shapes (read-only, 2026-10-30): auth.uid() as Supabase
-- defines it, referral_agents (id, user_id, is_test, agent_type), referrals (every live column), claims (the link and opt-out
-- columns; referrer_updates_opt_out boolean, nullable, no default), and the live client grants on referrals (#3217 B: table-level
-- wdDxt + a 7-column SELECT allow-list; MAINTAIN is PG17-only and omitted). The live function itself is NOT created here: the
-- runner applies supabase/migrations_drafts/gh3217a_get_my_referrals.sql, whose body equals production's byte for byte.
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$f$;
CREATE TABLE public.referral_agents (id uuid PRIMARY KEY, user_id uuid, agent_type text, is_test boolean DEFAULT false);
CREATE TABLE public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now(), referral_agent_id uuid, claim_id uuid,
  homeowner_name text, homeowner_email text, homeowner_phone text, status text, job_value numeric, commission_amount numeric,
  commission_paid_at timestamptz, landing_page text, utm_source text, utm_medium text, utm_campaign text, metadata jsonb,
  recruit_commission_amount numeric, recruit_paid_at timestamptz, is_test boolean DEFAULT false, homeowner_user_id uuid);
CREATE TABLE public.claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, referral_id uuid, referral_agent_id uuid,
  referrer_updates_opt_out boolean, is_test boolean DEFAULT false, created_at timestamptz DEFAULT now());
REVOKE ALL ON public.referrals, public.claims, public.referral_agents FROM PUBLIC, anon, authenticated;
GRANT UPDATE, DELETE, REFERENCES, TRIGGER ON public.referrals TO anon, authenticated;
GRANT SELECT (id, created_at, referral_agent_id, status, job_value, commission_amount, recruit_commission_amount) ON public.referrals TO authenticated;
GRANT ALL ON public.referrals, public.claims, public.referral_agents TO service_role;
