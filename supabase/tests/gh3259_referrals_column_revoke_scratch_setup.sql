-- gh-3259 scratch setup for the THROWAWAY Postgres proof. NEVER run against production.
-- Builds the live shape of public.referrals as read (SELECT only) from production yeszghaspzwwstvsrioa on 2026-10-30:
--   * every live column, in live order, with live types (numeric(12,2) / numeric(10,2) for the money columns);
--   * relacl {postgres=arwdDxtm/postgres,anon=wdDxtm/postgres,authenticated=wdDxtm/postgres,service_role=arwdDxtm/postgres}
--     (MAINTAIN `m` is PG17-only, so this PG16 model carries wdDxt / arwdDxt);
--   * column SELECT for authenticated on exactly id, created_at, referral_agent_id, status, job_value, commission_amount,
--     recruit_commission_amount (attacl {authenticated=r/postgres}; the #3217 B allow-list, live);
--   * RLS on, policies "Agents can read own referrals" (SELECT, roles {public}) and "Service role full access" (ALL);
--   * auth.uid() / auth.role() as Supabase defines them (read from request.jwt.claims), so a partner session is
--     SET ROLE authenticated + a JWT claims GUC, which is what PostgREST does for a partner's access token.
-- get_my_referrals() is NOT created here: the runner applies supabase/migrations_drafts/gh3217a_get_my_referrals.sql, whose
-- prosrc md5 equals production's (e63684bf6ce7d5b2da454ee00b31a9e9), and checks that md5.
-- admin_list_referrals() is a SECURITY DEFINER stand-in with the live return columns that matter here (job_value, status).
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
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$f$;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;

CREATE TABLE public.referral_agents (id uuid PRIMARY KEY, user_id uuid, agent_type text, is_test boolean DEFAULT false);
GRANT SELECT ON public.referral_agents TO authenticated, service_role;

-- live column order and types (pg_attribute, production, 2026-10-30)
CREATE TABLE public.referrals (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                timestamptz DEFAULT now(),
  referral_agent_id         uuid,
  claim_id                  uuid,
  homeowner_name            text,
  homeowner_email           text,
  homeowner_phone           text,
  status                    text NOT NULL DEFAULT 'clicked',
  job_value                 numeric(12,2),
  commission_amount         numeric(10,2),
  commission_paid_at        timestamptz,
  landing_page              text,
  utm_source                text,
  utm_medium                text,
  utm_campaign              text,
  metadata                  jsonb,
  recruit_commission_amount numeric(10,2),
  recruit_paid_at           timestamptz,
  is_test                   boolean DEFAULT false,
  homeowner_user_id         uuid
);
-- claims: only what the gh3241/gh3257 get_my_referrals() bodies read (section D of the runner)
CREATE TABLE public.claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, referral_id uuid, referral_agent_id uuid,
  referrer_updates_opt_out boolean, is_test boolean DEFAULT false, created_at timestamptz DEFAULT now());
GRANT ALL ON public.claims TO service_role;

REVOKE ALL ON public.referrals FROM PUBLIC, anon, authenticated;
GRANT UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.referrals TO anon, authenticated;
GRANT ALL ON public.referrals TO service_role;
GRANT SELECT (id, created_at, referral_agent_id, status, job_value, commission_amount, recruit_commission_amount)
  ON public.referrals TO authenticated;

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Agents can read own referrals" ON public.referrals FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.referral_agents
                 WHERE referral_agents.id = referrals.referral_agent_id AND referral_agents.user_id = (SELECT auth.uid() AS uid)));
CREATE POLICY "Service role full access" ON public.referrals
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- admin path stand-in (SECURITY DEFINER, owned by postgres, EXECUTE to authenticated like production)
CREATE FUNCTION public.admin_list_referrals()
RETURNS TABLE(id uuid, status text, job_value numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $f$
  SELECT r.id, r.status, r.job_value FROM public.referrals r ORDER BY r.created_at DESC
$f$;
REVOKE ALL ON FUNCTION public.admin_list_referrals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_referrals() TO authenticated, service_role;

-- fixtures: partner A owns two referrals, partner B one; H is a homeowner with no agent row
INSERT INTO auth.users(id, email) VALUES
  ('a3259000-0000-4000-8000-00000000000a', 'gh3259-a@example.invalid'),
  ('a3259000-0000-4000-8000-00000000000b', 'gh3259-b@example.invalid'),
  ('a3259000-0000-4000-8000-00000000000c', 'gh3259-h@example.invalid');
INSERT INTO public.referral_agents(id, user_id, agent_type, is_test) VALUES
  ('b3259000-0000-4000-8000-00000000000a', 'a3259000-0000-4000-8000-00000000000a', 're_agent', true),
  ('b3259000-0000-4000-8000-00000000000b', 'a3259000-0000-4000-8000-00000000000b', 're_agent', true);
INSERT INTO public.referrals(id, created_at, referral_agent_id, homeowner_name, status, job_value, commission_amount,
                             recruit_commission_amount, is_test) VALUES
  ('c3259000-0000-4000-8000-000000000001', '2026-10-01', 'b3259000-0000-4000-8000-00000000000a', 'Jane Q Public', 'job_completed', 18450.00, 200.00, 50.00, true),
  ('c3259000-0000-4000-8000-000000000002', '2026-10-02', 'b3259000-0000-4000-8000-00000000000a', 'Opt Out',       'registered',    NULL,     NULL,   NULL, true),
  ('c3259000-0000-4000-8000-000000000003', '2026-10-03', 'b3259000-0000-4000-8000-00000000000b', 'Bob Builder',   'contract_signed', 9100.00, NULL,  NULL, true);
