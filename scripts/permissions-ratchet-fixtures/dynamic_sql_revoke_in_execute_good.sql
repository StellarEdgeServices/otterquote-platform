-- RATCHET-FIXTURE: EXPECT=PASS
-- REVOKE (the FIX direction) wrapped in the exact same dynamic-SQL shape as
-- the dynamic-sql-grant probes above must still PASS -- rule 4 only fires
-- on a GRANT ... TO <role> shape inside a quoted/dollar-quoted span, never
-- on REVOKE, preserving the same asymmetry rule 1 encodes for plain
-- top-level statements.
BEGIN;

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.f() FROM anon';
END
$$;

COMMIT;
