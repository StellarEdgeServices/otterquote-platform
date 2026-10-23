-- gh-2881 THROWAWAY-POSTGRES MODEL of the pieces the proof touches. NEVER run on a real project. Supabase's default privileges are modelled
-- (anon, authenticated, service_role hold ALL on a new public table). Row policies mirror the live ones in kind: owner, admin, and a
-- contractor who is selected on the claim with a quote on it.
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(auth.jwt() ->> 'sub', '')::uuid $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_admin_email() RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public','pg_temp'
AS $$ SELECT (auth.jwt() ->> 'email') IN ('dustinstohler1@gmail.com','dustin@otterquote.com') $$;

CREATE TABLE public.contractors (id uuid PRIMARY KEY, user_id uuid NOT NULL, status text DEFAULT 'active', is_test boolean DEFAULT false);
CREATE TABLE public.claims (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, status text, property_address text, selected_contractor_id uuid,
  platform_fee_charged boolean, is_test boolean DEFAULT false, created_at timestamptz DEFAULT now(),
  urgency_reason text, homeowner_notes text, project_confirmation jsonb, trades text[]
);
CREATE TABLE public.quotes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid REFERENCES public.claims(id), contractor_id uuid REFERENCES public.contractors(id), total_price numeric);
GRANT ALL ON public.claims, public.contractors, public.quotes TO anon, authenticated, service_role;
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY ctr_self ON public.contractors FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY q_self ON public.quotes FOR SELECT TO authenticated USING (contractor_id IN (SELECT id FROM public.contractors WHERE user_id = auth.uid()));
CREATE POLICY "Users can view own claims" ON public.claims FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY claims_admin_select ON public.claims FOR SELECT TO authenticated USING (public.is_admin_email());
-- the two LIVE contractor policies, in kind: every active contractor reads a biddable claim; a contractor with a quote reads that claim
CREATE POLICY "Contractors can view biddable claims" ON public.claims FOR SELECT TO authenticated
  USING (status IN ('active','bidding') AND EXISTS (SELECT 1 FROM public.contractors k WHERE k.user_id = auth.uid() AND k.status = 'active'));
CREATE POLICY "Contractors can view claims for their quotes" ON public.claims FOR SELECT TO authenticated
  USING (id IN (SELECT q.claim_id FROM public.quotes q JOIN public.contractors k ON k.id = q.contractor_id WHERE k.user_id = auth.uid()));
-- homeowner / contractor writes stay as they are (not modelled further): the privilege check below proves UPDATE/INSERT are untouched
CREATE POLICY own_update ON public.claims FOR UPDATE TO authenticated USING (user_id = auth.uid());

-- fixtures (is_test): homeowner H, selected contractor S, non-selected bidder B, non-bidder N
INSERT INTO public.contractors (id, user_id, is_test) VALUES
 ('c0000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-00000000000a', true),
 ('c0000000-0000-0000-0000-000000000002','a2000000-0000-0000-0000-00000000000b', true),
 ('c0000000-0000-0000-0000-000000000003','a3000000-0000-0000-0000-00000000000c', true);
INSERT INTO public.claims (id, user_id, status, property_address, selected_contractor_id, platform_fee_charged, is_test, urgency_reason, homeowner_notes, project_confirmation)
 VALUES ('d0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-00000000000b','awarded','12 Elm St','c0000000-0000-0000-0000-000000000001', false, true, 'closing Friday', 'Call me at 317-555-0142 or jane@example.com', '{"homeownerNotes":"gate code 4412","workNotBeingDone":"fence, call 317-555-0142"}');
INSERT INTO public.quotes (claim_id, contractor_id, total_price) VALUES
 ('d0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001',12000),
 ('d0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002',13000);
