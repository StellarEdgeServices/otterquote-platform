-- RATCHET-FIXTURE: EXPECT=FAIL
-- EXECUTE format(...) where the ROLE itself is a %I placeholder bound to a
-- runtime variable -- the role cannot be statically determined from the
-- migration text alone. Rule 4 fails closed here as
-- dynamic-sql-grant-unknown-role rather than silently passing because no
-- literal dangerous-role name could be matched; the bypass label exists for
-- a human to review and clear a case like this.
BEGIN;

DO $$
DECLARE
  role_var text := 'anon';
BEGIN
  EXECUTE format('GRANT SELECT ON t TO %I', role_var);
END
$$;

COMMIT;
