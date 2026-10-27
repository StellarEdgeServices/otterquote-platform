-- ROLLBACK for gh3009_admin_emails_table.sql (restores the p18 literal-list function).
BEGIN;

CREATE OR REPLACE FUNCTION public.is_admin_email()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT (auth.jwt() ->> 'email') IN (
    'dustinstohler1@gmail.com',
    'dustin@otterquote.com'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin_email() TO PUBLIC;

DROP TABLE IF EXISTS public.admin_emails;

COMMIT;
