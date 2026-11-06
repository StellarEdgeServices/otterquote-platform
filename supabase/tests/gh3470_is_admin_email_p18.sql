-- LOCAL-ONLY: the p18 definition of is_admin_email() (supabase/migrations/20260621213735_p18_admin_identity_allowlist.sql): NULL on a JWT with no email claim.
CREATE OR REPLACE FUNCTION public.is_admin_email() RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS
  $$ SELECT (auth.jwt() ->> 'email') IN ('dustinstohler1@gmail.com', 'dustin@otterquote.com') $$;
