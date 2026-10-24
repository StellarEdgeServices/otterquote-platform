-- gh-2995: THROWAWAY schema for supabase/tests/gh2995_accept_cpa_proof.sql. Scratch Postgres only; never apply anywhere else.
-- HAND-WRITTEN MINIMAL MODEL (not a production dump): contractors with only the columns the freeze trigger and accept_cpa touch,
-- cpa_versions, activity_log (production columns, read 2026-10-23), auth.uid()/auth.jwt() (production definitions: they read
-- request.jwt.claims), record_cpa_ip() (baseline body, 20260101000000_v000_baseline_schema.sql:2316) and
-- contractors_freeze_privileged_columns() (the LIVE body read 2026-10-24 via pg_get_functiondef), auth.users (id, email only).
-- It does NOT model: RLS policies on contractors other than own-update, the other contractors triggers, grants beyond those below.
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

CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE TABLE public.contractors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,  -- production: contractors_user_id_fkey ON DELETE CASCADE
  email text, is_test boolean NOT NULL DEFAULT false,
  status text DEFAULT 'approved', template_review_role text, verified boolean DEFAULT false, rating numeric, review_count int DEFAULT 0,
  license_verified boolean DEFAULT false, license_verified_at timestamptz, insurance_verified boolean DEFAULT false, insurance_verified_at timestamptz,
  insurance_verification_sent_at timestamptz, insurance_verification_email text, approved_at timestamptz, rejected_at timestamptz, rejection_reason text,
  cert_status text, legacy_pre_approval boolean DEFAULT false, needs_cpa_reattestation boolean NOT NULL DEFAULT false, admin_notes text,
  has_payment_method boolean DEFAULT false, stripe_payment_method_id text, stripe_payment_method_last4 text,
  agreement_accepted_at timestamptz, agreement_version text, cpa_version text NOT NULL DEFAULT 'v1-2026-04', cpa_accepted_at timestamptz,  -- gh-2995 fix: matches production (cpa_version NOT NULL DEFAULT 'v1-2026-04'; needs_cpa_reattestation NOT NULL DEFAULT false; the other three nullable, no default; verified via information_schema 2026-10-24)
  ic_24511_attestation jsonb
);
ALTER TABLE public.contractors ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_update ON public.contractors FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY own_select ON public.contractors FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY own_insert ON public.contractors FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE ON public.contractors TO authenticated;

CREATE TABLE public.cpa_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version_label text NOT NULL UNIQUE, effective_date date, change_summary text,
  is_current boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX cpa_versions_single_current ON public.cpa_versions (is_current) WHERE is_current;
GRANT SELECT ON public.cpa_versions TO authenticated;
INSERT INTO public.cpa_versions (version_label, effective_date, change_summary, is_current) VALUES ('v1-2026-04', '2026-04-01', 'Initial Contractor Partner Agreement', true);

CREATE TABLE public.activity_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY, user_id uuid NOT NULL, event_type text NOT NULL, title text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), is_test boolean NOT NULL DEFAULT false
);
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.activity_log TO authenticated;

CREATE OR REPLACE FUNCTION public.record_cpa_ip(p_contractor_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_ip TEXT; v_ua TEXT; v_headers JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contractors WHERE id = p_contractor_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized for contractor %', p_contractor_id;
  END IF;
  BEGIN v_headers := current_setting('request.headers', true)::jsonb; EXCEPTION WHEN OTHERS THEN v_headers := '{}'::jsonb; END;
  v_ip := COALESCE(NULLIF(split_part(v_headers->>'x-forwarded-for', ',', 1), ''), v_headers->>'cf-connecting-ip', v_headers->>'x-real-ip');
  v_ua := v_headers->>'user-agent';
  UPDATE contractors SET ic_24511_attestation = COALESCE(ic_24511_attestation, '{}'::jsonb)
        || jsonb_build_object('cpa_reaccept', jsonb_build_object('accepted_ip', v_ip, 'accepted_ua', v_ua, 'accepted_at', NOW()))
  WHERE id = p_contractor_id;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.record_cpa_ip(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.contractors_freeze_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF coalesce(auth.jwt() ->> 'email', '') = 'dustinstohler1@gmail.com' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status                         := 'pending_approval';
    NEW.template_review_role           := NULL;
    NEW.verified                       := false;
    NEW.rating                         := NULL;
    NEW.review_count                   := 0;
    NEW.license_verified               := false;
    NEW.license_verified_at            := NULL;
    NEW.insurance_verified             := false;
    NEW.insurance_verified_at          := NULL;
    NEW.insurance_verification_sent_at := NULL;
    NEW.insurance_verification_email   := NULL;
    NEW.approved_at                    := NULL;
    NEW.rejected_at                    := NULL;
    NEW.rejection_reason               := NULL;
    NEW.cert_status                    := NULL;
    NEW.legacy_pre_approval            := false;
    NEW.needs_cpa_reattestation        := false;
    NEW.admin_notes                    := NULL;
    NEW.is_test                        := false;
    NEW.has_payment_method             := false;
    NEW.stripe_payment_method_id       := NULL;
    NEW.stripe_payment_method_last4    := NULL;
    RETURN NEW;
  END IF;

  NEW.status                         := OLD.status;
  NEW.template_review_role           := OLD.template_review_role;
  NEW.verified                       := OLD.verified;
  NEW.rating                         := OLD.rating;
  NEW.review_count                   := OLD.review_count;
  NEW.license_verified               := OLD.license_verified;
  NEW.license_verified_at            := OLD.license_verified_at;
  NEW.insurance_verified             := OLD.insurance_verified;
  NEW.insurance_verified_at          := OLD.insurance_verified_at;
  NEW.insurance_verification_sent_at := OLD.insurance_verification_sent_at;
  NEW.insurance_verification_email   := OLD.insurance_verification_email;
  NEW.approved_at                    := OLD.approved_at;
  NEW.rejected_at                    := OLD.rejected_at;
  NEW.rejection_reason               := OLD.rejection_reason;
  NEW.cert_status                    := OLD.cert_status;
  NEW.legacy_pre_approval            := OLD.legacy_pre_approval;
  NEW.needs_cpa_reattestation        := CASE
    WHEN OLD.needs_cpa_reattestation = true
     AND NEW.needs_cpa_reattestation = false
     AND NEW.cpa_version = (SELECT cv.version_label FROM public.cpa_versions cv WHERE cv.is_current LIMIT 1)
    THEN false
    ELSE OLD.needs_cpa_reattestation
  END;
  NEW.admin_notes                    := OLD.admin_notes;
  NEW.is_test                        := OLD.is_test;
  NEW.has_payment_method             := OLD.has_payment_method;
  NEW.stripe_payment_method_id       := OLD.stripe_payment_method_id;
  NEW.stripe_payment_method_last4    := OLD.stripe_payment_method_last4;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER contractors_freeze_privileged_columns BEFORE INSERT OR UPDATE ON public.contractors
  FOR EACH ROW EXECUTE FUNCTION public.contractors_freeze_privileged_columns();

-- Two is_test contractors for the proof (production proof picks existing is_test rows instead; see the proof header).
INSERT INTO auth.users (id, email) VALUES ('aaaaaaaa-1111-4000-8000-000000000001','a@otterquote-internal.test'),('bbbbbbbb-1111-4000-8000-000000000002','b@otterquote-internal.test');
INSERT INTO public.contractors (id, user_id, email, is_test) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-1111-4000-8000-000000000001', 'a@otterquote-internal.test', true),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-1111-4000-8000-000000000002', 'b@otterquote-internal.test', true);
