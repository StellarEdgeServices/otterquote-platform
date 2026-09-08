-- RATCHET-FIXTURE: EXPECT=FAIL
-- Lower-case keywords, a multi-line statement, and the role split across
-- lines -- the parser must not depend on single-line, upper-case SQL.
BEGIN;

grant
  execute
  on function public.some_helper()
to
  ANON;

COMMIT;
