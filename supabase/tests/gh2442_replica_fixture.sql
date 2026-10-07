-- gh-2442: scratch-database fixture for supabase/tests/gh2442_dunning_retry_request_proof.sql.
-- NEVER RUN ON PRODUCTION OR ANY SUPABASE PROJECT. It is for an empty throwaway Postgres only: it creates the
-- roles, the auth helpers and the tables the proof needs, so the proof can run without touching a real database.
-- payment_failures below is the live definition as read from production by read-only SELECT on 2026-10-07
-- (information_schema.columns, pg_constraint, pg_policies, role_table_grants): 15 columns, the dunning_status
-- CHECK, RLS on, 3 policies, and the anon / authenticated table grants exactly as they stand, including the three
-- anon write grants the migration removes. contractors, profiles, claims and quotes are cut down to the columns
-- the proof and the function read. auth.uid() and auth.jwt() read request.jwt.claims as Supabase's do.
-- Production is PostgreSQL 17.6; the scratch run recorded in the pre-flight used PostgreSQL 16.
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(auth.jwt() ->> 'sub', '')::uuid $$;
-- Supabase's default: functions created in public are executable by anon, authenticated and service_role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), is_test boolean NOT NULL DEFAULT false);
CREATE TABLE public.contractors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE, is_test boolean NOT NULL DEFAULT false);
CREATE TABLE public.claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.quotes (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
GRANT SELECT ON public.profiles, public.contractors TO anon, authenticated;

CREATE TABLE public.payment_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid REFERENCES public.quotes(id),
  contractor_id uuid REFERENCES public.contractors(id),
  claim_id uuid REFERENCES public.claims(id),
  homeowner_id uuid,
  amount_cents integer NOT NULL,
  stripe_error text,
  dunning_status text DEFAULT 'active' CHECK (dunning_status = ANY (ARRAY['active','warning_sent','homeowner_notified','contractor_out','resolved','escalated','expired'])),
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  next_reminder_at timestamptz,
  reminder_count integer DEFAULT 0,
  contractor_timezone text DEFAULT 'America/New_York',
  warning_at timestamptz,
  homeowner_notify_at timestamptz
);
ALTER TABLE public.payment_failures ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_select_payment_failures ON public.payment_failures FOR SELECT
  USING ((auth.jwt() ->> 'email') = 'admin@example.invalid');
CREATE POLICY admin_update_payment_failures ON public.payment_failures FOR UPDATE
  USING ((auth.jwt() ->> 'email') = 'admin@example.invalid');
CREATE POLICY contractor_select_own_payment_failures ON public.payment_failures FOR SELECT
  USING (contractor_id IN (SELECT contractors.id FROM public.contractors WHERE contractors.user_id = (SELECT auth.uid() AS uid)));
GRANT SELECT, UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public.payment_failures TO anon;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.payment_failures TO authenticated;

-- two test contractors with a login, one test profile that is not a contractor
WITH u AS (INSERT INTO public.profiles (is_test) VALUES (true), (true), (true) RETURNING id),
     n AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM u)
INSERT INTO public.contractors (user_id, is_test) SELECT id, true FROM n WHERE rn <= 2;
