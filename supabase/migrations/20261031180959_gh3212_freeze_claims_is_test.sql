SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.claims_freeze_is_test()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role' THEN
    IF NEW.is_test IS DISTINCT FROM OLD.is_test THEN
      RAISE EXCEPTION 'claims.is_test can only be changed by service_role (gh-3212)' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS claims_freeze_is_test ON public.claims;
CREATE TRIGGER claims_freeze_is_test
  BEFORE UPDATE OF is_test ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.claims_freeze_is_test();