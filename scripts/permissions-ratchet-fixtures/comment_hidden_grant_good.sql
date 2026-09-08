-- RATCHET-FIXTURE: EXPECT=PASS
-- A GRANT-to-anon that exists ONLY inside comments (line comment and block
-- comment) must never trigger -- comments are not executable SQL.
BEGIN;

-- GRANT EXECUTE ON FUNCTION public.some_helper() TO anon;
/* GRANT EXECUTE ON FUNCTION public.some_other_helper() TO anon; */
REVOKE EXECUTE ON FUNCTION public.some_helper() FROM anon;

COMMIT;
