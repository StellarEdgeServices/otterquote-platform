-- gh-3471 coverage: THROWAWAY schema for supabase/tests/gh3471_guarantee_covered_proof.sql. Scratch Postgres only; never apply anywhere else.
-- HAND-WRITTEN MODEL, not a production dump: hover_orders columns from supabase/migrations/20260101000000_v000_baseline_schema.sql (lines 577-606) plus admin_notes,
-- the two clock columns and hover_orders_guarantee_clock_chk exactly as supabase/migrations_drafts/gh3471_guarantee_clock.sql creates them (applied in production as
-- ledger 20261108222038, #3471 comment 6727950306); RLS on with the two policies that pre-flight check 3 of the clock found (hover_orders_admin_all, hover_user_read);
-- platform_settings as in the baseline (lines 774-778) with RLS on and its key allow-list SELECT policy. is_admin_email() is a stub returning false.
\set ON_ERROR_STOP on
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION public.is_admin_email() RETURNS boolean LANGUAGE sql STABLE AS $$ select false $$;

CREATE TABLE public.hover_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  claim_id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text DEFAULT 'pending'::text,
  amount_charged numeric(10,2),
  stripe_payment_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  homeowner_charge_amount integer,
  homeowner_stripe_payment_intent_id text,
  rebate_due boolean DEFAULT false,
  admin_notes text,
  guarantee_started_at timestamptz,
  guarantee_deadline_at timestamptz
);
ALTER TABLE public.hover_orders ADD CONSTRAINT hover_orders_guarantee_clock_chk CHECK (
  (guarantee_started_at IS NULL AND guarantee_deadline_at IS NULL)
  OR (guarantee_started_at IS NOT NULL AND guarantee_deadline_at IS NOT NULL AND guarantee_deadline_at = guarantee_started_at + interval '100 hours'));
ALTER TABLE public.hover_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY hover_orders_admin_all ON public.hover_orders FOR ALL USING (is_admin_email()) WITH CHECK (is_admin_email());
CREATE POLICY hover_user_read ON public.hover_orders FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE TABLE public.platform_settings (key text NOT NULL PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz DEFAULT now());
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read public settings" ON public.platform_settings FOR SELECT TO authenticated
  USING (key = ANY (ARRAY['D204_HARD_FILTER','hover_measurement_price','platform_fee_percentage','skip_hover_in_test','measurement_products','w9_gate_retired']));
INSERT INTO public.platform_settings (key, value) VALUES ('homeowner_blocked_states', '["FL","LA","TX"]');

-- Existing orders before the apply: one with no clock (test/contractor), two with a clock (real, paid after gh-3471 shipped). All must survive and validate.
INSERT INTO public.hover_orders (admin_notes) VALUES ('seed-noclock');
INSERT INTO public.hover_orders (admin_notes, guarantee_started_at, guarantee_deadline_at) VALUES
  ('seed-clock-1', '2026-11-08T23:00:00Z', '2026-11-08T23:00:00Z'::timestamptz + interval '100 hours'),
  ('seed-clock-2', '2026-11-09T01:00:00Z', '2026-11-09T01:00:00Z'::timestamptz + interval '100 hours');
