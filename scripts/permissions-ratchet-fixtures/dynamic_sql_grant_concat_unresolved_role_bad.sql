-- RATCHET-FIXTURE: EXPECT=FAIL
-- Follow-up work order's own example: the role half of the concatenation is
-- not a string literal at all but a function call (`quote_ident(r)`), so
-- there is no second literal span to merge with. The GRANT...TO literal
-- ends bare (`TO ` with nothing but trailing whitespace before its closing
-- quote) -- the role "arrives from elsewhere" and can never be statically
-- resolved. Must fail closed as dynamic-sql-grant-unknown-role, the same
-- posture rule 4 already takes for an unresolved format() placeholder.
BEGIN;

CREATE OR REPLACE FUNCTION public.grant_to_role(r text) RETURNS void AS $$
BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.f() TO ' || quote_ident(r);
END;
$$ LANGUAGE plpgsql;

COMMIT;
