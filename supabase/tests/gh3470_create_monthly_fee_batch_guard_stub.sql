-- LOCAL-ONLY stub for the gh-3470 proof (throwaway Postgres 16, never production): only what create_monthly_fee_batch touches.
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt() ->> 'role' $$;
CREATE TABLE public.platform_settings (key text PRIMARY KEY, value jsonb NOT NULL);
INSERT INTO public.platform_settings VALUES ('partner_payout_minimum_cents', '2500');
CREATE TABLE public.referral_agents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), first_name text, last_name text, payments_blocked boolean NOT NULL DEFAULT false);
CREATE TABLE public.partner_fee_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), referral_agent_id uuid REFERENCES public.referral_agents(id),
  is_test boolean NOT NULL DEFAULT false, amount_cents integer NOT NULL, status text NOT NULL DEFAULT 'accrued', payout_approval_id uuid, created_at timestamptz NOT NULL DEFAULT '2019-12-15');
CREATE TABLE public.payout_approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), referral_id uuid, payout_type text, partner_id uuid, partner_name text,
  amount numeric, trigger_event text, status text, auto_approve_at timestamptz, is_test boolean NOT NULL DEFAULT false);
INSERT INTO public.referral_agents (id, first_name, last_name) VALUES ('11111111-1111-1111-1111-111111111111', 'Test', 'Partner');
INSERT INTO public.partner_fee_events (referral_agent_id, amount_cents) SELECT '11111111-1111-1111-1111-111111111111', 500 FROM generate_series(1, 6);
-- admin allowlist table for the live (gh3009) form
CREATE TABLE public.admin_emails (email text PRIMARY KEY);
INSERT INTO public.admin_emails VALUES ('dustinstohler1@gmail.com'), ('dustin@otterquote.com');
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
