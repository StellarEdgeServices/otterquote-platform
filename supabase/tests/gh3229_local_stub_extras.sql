-- LOCAL-ONLY additions to local_pg16/00_stub_schema.sql for the gh-3229 proof run (throwaway Postgres, never production).
-- Tables/columns the migration and the proof touch that the base stub lacks. RLS on partner_fee_events comes from the migration itself.
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
ALTER TABLE public.referral_agents
  ADD COLUMN user_id uuid, ADD COLUMN payments_blocked boolean NOT NULL DEFAULT true,
  ADD COLUMN email text, ADD COLUMN unique_code text;
ALTER TABLE public.payout_approvals
  ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN paid_at timestamptz, ADD COLUMN rejected_at timestamptz;
ALTER TABLE public.payout_approvals ALTER COLUMN status SET DEFAULT 'pending_approval';
ALTER TABLE public.payout_approvals ADD CONSTRAINT payout_approvals_payout_type_check
  CHECK (payout_type = ANY (ARRAY['commission_referral'::text, 'commission_recruit'::text]));
CREATE TABLE public.hover_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid NOT NULL REFERENCES public.claims(id), user_id uuid NOT NULL,
  status text DEFAULT 'pending', stripe_payment_id text, homeowner_charge_amount integer, homeowner_stripe_payment_intent_id text,
  requested_by_role text, rebate_due boolean DEFAULT false, rebate_paid_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE public.platform_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz DEFAULT now());
CREATE FUNCTION public.is_admin_email() RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS
  $$ SELECT (auth.jwt() ->> 'email') IN ('dustinstohler1@gmail.com', 'dustin@otterquote.com') $$;
CREATE FUNCTION public.referral_attribution_window() RETURNS interval LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS
  $$ SELECT interval '30 days' $$;
-- stand-in for #3242's partner_v4_accepted_at(agent): reads a stub table the proof fills (the real function reads referral_agents' agreement columns)
CREATE TABLE public.gh3229_stub_v4 (agent_id uuid PRIMARY KEY, accepted_at timestamptz);
CREATE FUNCTION public.partner_v4_accepted_at(p_agent uuid) RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS
  $$ SELECT s.accepted_at FROM public.gh3229_stub_v4 s WHERE s.agent_id = p_agent $$;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
