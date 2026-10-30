-- gh-3224 scratch-database setup ONLY (never run on production). Rebuilds just enough of production for the proof:
-- contractor_templates with its live columns, unique index, RLS policies and grants, the live bodies of
-- contractor_templates_freeze_verdict and enforce_template_privileged_columns (pg_get_functiondef, 2026-10-30)
-- and their triggers, plus stubs for auth.* and request_is_privileged/is_admin_email.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt() ->> 'sub')::uuid $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid() TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.is_admin_email() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.request_is_privileged() RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT current_setting('request.jwt.claims', true) IS NULL
      OR coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      OR public.is_admin_email();
$$;
CREATE TABLE public.contractors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, template_review_role text);
GRANT SELECT ON public.contractors TO authenticated, service_role;
CREATE TABLE public.contractor_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contractor_id uuid NOT NULL, trade text NOT NULL, funding_type text NOT NULL,
  pdf_storage_path text NOT NULL, status text NOT NULL DEFAULT 'pending_validation', validation_result jsonb, manual_overrides jsonb,
  admin_notes text, reviewed_by uuid, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX unique_active_template ON public.contractor_templates (contractor_id, trade, funding_type);
GRANT ALL ON public.contractor_templates TO anon, authenticated, service_role;
ALTER TABLE public.contractor_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY contractor_templates_admin ON public.contractor_templates FOR ALL
  USING (EXISTS (SELECT 1 FROM contractors WHERE contractors.user_id = (SELECT auth.uid()) AND contractors.template_review_role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM contractors WHERE contractors.user_id = (SELECT auth.uid()) AND contractors.template_review_role = 'admin'));
CREATE POLICY contractor_templates_self ON public.contractor_templates FOR ALL
  USING (contractor_id IN (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid())))
  WITH CHECK (contractor_id IN (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid())));

CREATE OR REPLACE FUNCTION public.contractor_templates_freeze_verdict() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
BEGIN
  -- Exempt service_role (EF/system), the admin account, and appointed template reviewers.
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;
  IF coalesce(auth.jwt() ->> 'email','') = 'dustinstohler1@gmail.com' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.contractors c
             WHERE c.user_id = (select auth.uid()) AND c.template_review_role = 'admin') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status            := 'pending_validation';
    NEW.validation_result := NULL;
    NEW.reviewed_by       := NULL;
    NEW.reviewed_at       := NULL;
    NEW.admin_notes       := NULL;
    RETURN NEW;
  END IF;

  -- Regular contractor UPDATE: verdict/admin fields are never theirs to write.
  NEW.reviewed_by  := OLD.reviewed_by;
  NEW.reviewed_at  := OLD.reviewed_at;
  NEW.admin_notes  := OLD.admin_notes;

  IF (NEW.pdf_storage_path IS DISTINCT FROM OLD.pdf_storage_path)
     OR (NEW.manual_overrides IS DISTINCT FROM OLD.manual_overrides)
     OR (NEW.trade IS DISTINCT FROM OLD.trade)
     OR (NEW.funding_type IS DISTINCT FROM OLD.funding_type) THEN
    NEW.status            := 'pending_validation';
    NEW.validation_result := NULL;
  ELSE
    NEW.status            := OLD.status;
    NEW.validation_result := OLD.validation_result;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_template_privileged_columns() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
BEGIN
  IF public.request_is_privileged()
     OR EXISTS (SELECT 1 FROM public.contractors
                 WHERE user_id = (SELECT auth.uid())
                   AND template_review_role = 'admin') THEN
    RETURN NEW;
  END IF;

  -- #510: permit the freeze_verdict re-validation reset (status->pending_validation
  -- + validation_result->NULL) that accompanies a template re-upload/re-map.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       NEW.status = 'pending_validation'
       AND NEW.validation_result IS NULL
       AND (
         NEW.pdf_storage_path IS DISTINCT FROM OLD.pdf_storage_path
         OR NEW.manual_overrides IS DISTINCT FROM OLD.manual_overrides
         OR NEW.trade IS DISTINCT FROM OLD.trade
         OR NEW.funding_type IS DISTINCT FROM OLD.funding_type
       )
     ) THEN
    RAISE EXCEPTION 'contractor_templates: review/validation columns are admin-managed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.admin_notes IS DISTINCT FROM OLD.admin_notes THEN
    RAISE EXCEPTION 'contractor_templates: review/validation columns are admin-managed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;
CREATE TRIGGER contractor_templates_freeze_verdict BEFORE INSERT OR UPDATE ON public.contractor_templates FOR EACH ROW EXECUTE FUNCTION contractor_templates_freeze_verdict();
CREATE TRIGGER trg_templates_privileged_guard BEFORE UPDATE ON public.contractor_templates FOR EACH ROW EXECUTE FUNCTION enforce_template_privileged_columns();

-- fixtures that exist BEFORE the migration (backfill check): one already-rejected and one admin_validated template
INSERT INTO public.contractors(id, user_id, template_review_role) VALUES
  ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1', NULL),
  ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000a2', NULL),
  ('00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000a3', NULL),
  ('00000000-0000-0000-0000-0000000000cd','00000000-0000-0000-0000-0000000000ad', 'admin');
INSERT INTO public.contractor_templates(id, contractor_id, trade, funding_type, pdf_storage_path, status, reviewed_at) VALUES
  ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-0000000000c3','roofing','retail','c3/old.pdf','rejected', '2026-10-01T00:00:00Z'),
  ('00000000-0000-0000-0000-00000000b002','00000000-0000-0000-0000-0000000000c3','siding','retail','c3/s.pdf','admin_validated', '2026-10-02T00:00:00Z');
