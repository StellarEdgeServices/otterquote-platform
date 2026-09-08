-- RATCHET-FIXTURE: EXPECT=PASS
-- Same ALTER ... SECURITY DEFINER, but the accompanying grant is to
-- service_role only -- rule 2 must not fire, and rule 1 passes it too.
BEGIN;

ALTER FUNCTION public.some_existing_fn() SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION public.some_existing_fn() TO service_role;

COMMIT;
