-- LOCAL-ONLY stub schema for the gh-2479 / gh-2403 proofs on a throwaway Postgres 16 (never production).
-- It holds ONLY the tables and columns the guarded functions and the proofs touch. The functions and
-- triggers under test are NOT stubbed: run.sh loads them from supabase/migrations/. There is no RLS here,
-- so a local run proves the trigger and function layer (guards, apply_referral_commission), not policies.
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth; CREATE SCHEMA vault; CREATE SCHEMA net;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt() ->> 'role' $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(auth.jwt() ->> 'sub', '')::uuid $$;
CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;

CREATE TABLE public.profiles (id uuid PRIMARY KEY, is_test boolean NOT NULL DEFAULT false);
CREATE TABLE public.contractors (id uuid PRIMARY KEY, user_id uuid, is_test boolean NOT NULL DEFAULT false);
CREATE TABLE public.referral_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_type text, is_test boolean NOT NULL DEFAULT false,
  recruited_by_id uuid, recruited_at timestamptz, first_name text, last_name text, recruit_earnings numeric);
CREATE TABLE public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), referral_agent_id uuid REFERENCES public.referral_agents(id),
  status text, commission_amount numeric, recruit_commission_amount numeric, job_value numeric,
  created_at timestamptz NOT NULL DEFAULT now(), is_test boolean NOT NULL DEFAULT false);
-- claims.created_at is NULLABLE on production (information_schema read, #2403 comment 6159265101 query 5); keep it so.
CREATE TABLE public.claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), is_test boolean NOT NULL DEFAULT false, status text DEFAULT 'documents_needed',
  referral_id uuid, completion_date timestamptz, trades text[], selected_contractor_id uuid,
  selected_bid_amount numeric, contract_signed_at timestamptz, job_type text, funding_type text,
  ready_for_bids boolean);
CREATE TABLE public.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid, contractor_id uuid, total_price numeric,
  fee_percentage numeric, fee_amount numeric, platform_fee_pct numeric, platform_fee_basis text,
  status text DEFAULT 'submitted', bid_status text DEFAULT 'active', is_auto_bid boolean, renewed_from_quote_id uuid,
  homeowner_signed_at timestamptz, contractor_signed_at timestamptz, payment_status text,
  is_test boolean NOT NULL DEFAULT false, trade_type text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.payout_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), referral_id uuid, payout_type text, partner_id uuid,
  partner_name text, amount numeric, trigger_event text, status text, auto_approve_at timestamptz,
  is_test boolean NOT NULL DEFAULT false, approved_at timestamptz);
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
