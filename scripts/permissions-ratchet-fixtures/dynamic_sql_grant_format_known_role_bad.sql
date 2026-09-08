-- RATCHET-FIXTURE: EXPECT=FAIL
-- EXECUTE format(...) where only the object name is parameterised (%I) and
-- the role in the TO clause is a literal ('anon'). Rule 4 must catch this
-- as a plain dynamic-sql-grant (known role), distinct from the
-- unknown-role variant where the ROLE itself is the placeholder.
BEGIN;

DO $$
DECLARE
  fn text := 'public.f';
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I TO anon', fn);
END
$$;

COMMIT;
