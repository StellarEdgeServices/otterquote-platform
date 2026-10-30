-- gh-3245: THROWAWAY schema for supabase/tests/gh3245_customer_fee_v4_gate_proof.sql. Scratch Postgres 16 only.
-- Loaded by the runner AFTER gh3239_throwaway_schema.sql + the extracted live register_partner() + the gh3239 forward file
-- (that chain provides referral_agents, auth.*, roles and partner_v4_accepted_at()). This file adds what
-- apply_referral_commission() touches, with production's column names (information_schema read 2026-10-30):
--   claims (only the columns the function reads), quotes (same), referrals, payout_approvals, platform_settings,
--   referral_attribution_window() (production body), vault.decrypted_secrets (one placeholder secret, so the edge-function calls are
--   reached) and net.http_post (records each call in net.proof_calls; nothing is sent).
-- apply_referral_commission() itself is NOT here: the runner extracts it from
-- supabase/migrations/20261015205902_gh2519_quotes_server_set_fee.sql lines 399-658 (md5 7f7d0419..., equal to production).
\set ON_ERROR_STOP on
CREATE SCHEMA IF NOT EXISTS vault;
-- vault holds a placeholder cron_service_role_key so the function's edge-function calls are REACHED, and net.http_post records
-- each call in net.proof_calls instead of sending it (the proof asserts which referrals trigger send-partner-status-email).
CREATE VIEW vault.decrypted_secrets AS SELECT 'cron_service_role_key'::text AS name, 'proof-placeholder'::text AS decrypted_secret;
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net.proof_calls (n serial, url text, body jsonb);
CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb) RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO net.proof_calls (url, body) VALUES (url, body) RETURNING n::bigint
$f$;

CREATE TABLE public.platform_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz DEFAULT now());

CREATE OR REPLACE FUNCTION public.referral_attribution_window()
 RETURNS interval LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT make_interval(days => COALESCE(
    (SELECT CASE WHEN (s.value #>> '{}') ~ '^[0-9]{1,4}$'
                 THEN CASE WHEN (s.value #>> '{}')::int BETWEEN 1 AND 3650
                           THEN (s.value #>> '{}')::int END
            END
       FROM public.platform_settings s
      WHERE s.key = 'partner_attribution_window_days'),
    90))
$function$;

CREATE TABLE public.referrals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now() NOT NULL,
  referral_agent_id uuid NOT NULL,
  claim_id uuid,
  status text DEFAULT 'clicked' NOT NULL,
  job_value numeric,
  commission_amount numeric,
  recruit_commission_amount numeric DEFAULT 0,
  is_test boolean DEFAULT false NOT NULL
);

CREATE TABLE public.claims (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  referral_id uuid,
  selected_contractor_id uuid,
  is_test boolean DEFAULT false NOT NULL,
  completion_date timestamptz
);

CREATE TABLE public.quotes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id uuid,
  contractor_id uuid,
  status text,
  total_price numeric,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.payout_approvals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  referral_id uuid,
  payout_type text NOT NULL,
  partner_id uuid,
  partner_name text,
  amount numeric NOT NULL,
  trigger_event text,
  status text DEFAULT 'pending_approval' NOT NULL,
  auto_approve_at timestamptz,
  created_at timestamptz DEFAULT now(),
  is_test boolean DEFAULT false NOT NULL
);
