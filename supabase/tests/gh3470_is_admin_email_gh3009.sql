-- LOCAL-ONLY: the LIVE definition of is_admin_email() (gh3009, pg_get_functiondef read from production 2026-11-05): EXISTS(), never NULL.
CREATE OR REPLACE FUNCTION public.is_admin_email() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS
  $$ SELECT EXISTS (SELECT 1 FROM public.admin_emails ae WHERE ae.email = (auth.jwt() ->> 'email')); $$;
