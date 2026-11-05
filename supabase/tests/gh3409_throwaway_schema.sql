-- gh-3409: THROWAWAY schema for the fee_acceptances client-insert guard proof. Scratch Postgres only; never apply anywhere else.
-- HAND-WRITTEN MODEL, not a production dump. fee_acceptances columns, indexes, the four policies and RLS come from supabase/migrations/20260101000000_v000_baseline_schema.sql (544-561, 3454, 3624-3635).
-- Grants model what production showed on 2026-11-05 (read-only): anon INSERT/SELECT/UPDATE/REFERENCES/TRIGGER; authenticated INSERT/SELECT/UPDATE/DELETE/REFERENCES/TRIGGER; service_role all. No trigger.
-- quotes keeps only the columns the guard reads plus the production read policy "Contractors can read own quotes" (a client sees only its own bids). quotes_platform_fee_for is a stub so the prerequisite check can pass
-- (gh-2519 is applied on production; the real function is not modelled, the proof seeds bids with the fee already server-set).
\set ON_ERROR_STOP on
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')) $$;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt(), auth.role() TO anon, authenticated, service_role;

CREATE TABLE public.contractors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE);
CREATE TABLE public.claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
GRANT SELECT ON public.contractors TO authenticated, anon;   -- contractors RLS is not modelled
CREATE TABLE public.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  total_price numeric(12,2) NOT NULL,
  fee_percentage numeric(5,2) NOT NULL,
  fee_amount numeric(12,2) NOT NULL,
  status text DEFAULT 'submitted',
  created_at timestamptz DEFAULT now(),
  bid_status text DEFAULT 'active' NOT NULL,
  platform_fee_pct numeric(5,2),
  platform_fee_basis text
);
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Contractors can read own quotes" ON public.quotes AS PERMISSIVE FOR SELECT TO public
  USING ((contractor_id IN ( SELECT contractors.id FROM contractors WHERE (contractors.user_id = ( SELECT auth.uid() AS uid)))));
GRANT SELECT ON public.quotes TO authenticated, anon;
CREATE OR REPLACE FUNCTION public.quotes_platform_fee_for(p_contractor_id uuid, p_claim_id uuid) RETURNS TABLE (fee_pct numeric, fee_basis text)
  LANGUAGE sql AS $$ SELECT 5.00::numeric, 'bid_amount'::text $$;

CREATE TABLE IF NOT EXISTS public.fee_acceptances (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  contractor_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  bid_id uuid NOT NULL,
  fee_pct numeric(5,2) NOT NULL,
  fee_basis text NOT NULL,
  fee_amount numeric(10,2) NOT NULL,
  fee_text_displayed text NOT NULL,
  accepted_at timestamp with time zone DEFAULT now() NOT NULL,
  ip_address inet,
  user_agent text,
  invoice_url text,
  rescinded_at timestamp with time zone,
  rescission_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.fee_acceptances ADD CONSTRAINT fee_acceptances_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.fee_acceptances ADD CONSTRAINT fee_acceptances_bid_id_fkey FOREIGN KEY (bid_id) REFERENCES quotes(id);
ALTER TABLE ONLY public.fee_acceptances ADD CONSTRAINT fee_acceptances_claim_id_fkey FOREIGN KEY (claim_id) REFERENCES claims(id);
ALTER TABLE ONLY public.fee_acceptances ADD CONSTRAINT fee_acceptances_contractor_id_fkey FOREIGN KEY (contractor_id) REFERENCES contractors(id);
CREATE INDEX idx_fee_acceptances_bid ON public.fee_acceptances USING btree (bid_id);
CREATE INDEX idx_fee_acceptances_claim ON public.fee_acceptances USING btree (claim_id);
CREATE INDEX idx_fee_acceptances_contractor ON public.fee_acceptances USING btree (contractor_id);
ALTER TABLE public.fee_acceptances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admin can read all fee acceptances" ON public.fee_acceptances AS PERMISSIVE FOR SELECT TO public
  USING (((auth.jwt() ->> 'email'::text) = 'dustinstohler1@gmail.com'::text));
CREATE POLICY "Admin can update fee acceptances" ON public.fee_acceptances AS PERMISSIVE FOR UPDATE TO public
  USING (((auth.jwt() ->> 'email'::text) = 'dustinstohler1@gmail.com'::text));
CREATE POLICY "Contractors can insert own fee acceptances" ON public.fee_acceptances AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((contractor_id IN ( SELECT contractors.id FROM contractors WHERE (contractors.user_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "Contractors can read own fee acceptances" ON public.fee_acceptances AS PERMISSIVE FOR SELECT TO public
  USING ((contractor_id IN ( SELECT contractors.id FROM contractors WHERE (contractors.user_id = ( SELECT auth.uid() AS uid)))));
REVOKE ALL ON public.fee_acceptances FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, REFERENCES, TRIGGER ON public.fee_acceptances TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON public.fee_acceptances TO authenticated;
GRANT ALL ON public.fee_acceptances TO service_role;
