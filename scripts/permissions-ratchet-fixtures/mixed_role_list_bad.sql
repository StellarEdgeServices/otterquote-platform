-- RATCHET-FIXTURE: EXPECT=FAIL
-- A comma-separated role list where only ONE role is dangerous must still
-- fail -- every named role has to be on the allowlist, not just one of them.
BEGIN;

GRANT EXECUTE ON FUNCTION public.some_helper() TO service_role, anon;

COMMIT;
