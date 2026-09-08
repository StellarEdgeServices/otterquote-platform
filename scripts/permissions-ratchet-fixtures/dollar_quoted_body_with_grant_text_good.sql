-- RATCHET-FIXTURE: EXPECT=PASS
-- A function body (dollar-quoted) that CONTAINS the literal text
-- "GRANT ... TO anon" as a string constant, e.g. logged/raised in an error
-- message, must never be mistaken for a real statement.
BEGIN;

CREATE OR REPLACE FUNCTION public.some_audit_fn()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE NOTICE 'reminder: never run GRANT EXECUTE ON FUNCTION x() TO anon;';
END;
$$;

COMMIT;
