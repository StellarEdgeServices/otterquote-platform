-- gh-3320: THROWAWAY schema for supabase/tests/gh3320_fee_acceptances_append_only_proof.sql. Scratch Postgres only; never apply anywhere else.
-- HAND-WRITTEN MODEL, not a production dump. Table columns, indexes and the four policies are copied from supabase/migrations/20260101000000_v000_baseline_schema.sql
-- (fee_acceptances lines 544-561; policies lines 3624-3635; RLS enabled line 3454). Parent tables are id-only stubs so the three baseline FKs can exist.
-- GRANTS model the figures measured by the issue (#3320 body, Supabase MCP SELECT, CEO RUN 143, 2026-11-02): authenticated holds UPDATE and DELETE; anon holds UPDATE and not
-- DELETE (gh-1529 revoked anon DELETE); RLS on, not forced; no TRUNCATE for either client role (gh-3240). service_role holds everything. No triggers (the issue reports none).
-- The author read no production database; those grant figures are the filer's, re-measured by the applier in the pre-flight.
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
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated, service_role;

CREATE TABLE public.contractors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE);
CREATE TABLE public.claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.quotes (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
GRANT SELECT ON public.contractors TO authenticated, anon;   -- the own-row policies read contractors inside their predicate (RLS on contractors is not modelled)

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
  WITH CHECK ((contractor_id IN ( SELECT contractors.id
   FROM contractors
  WHERE (contractors.user_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "Contractors can read own fee acceptances" ON public.fee_acceptances AS PERMISSIVE FOR SELECT TO public
  USING ((contractor_id IN ( SELECT contractors.id
   FROM contractors
  WHERE (contractors.user_id = ( SELECT auth.uid() AS uid)))));

REVOKE ALL ON public.fee_acceptances FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, REFERENCES, TRIGGER ON public.fee_acceptances TO anon;            -- no DELETE (gh-1529), no TRUNCATE (gh-3240)
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON public.fee_acceptances TO authenticated;   -- no TRUNCATE (gh-3240)
GRANT ALL ON public.fee_acceptances TO service_role;
