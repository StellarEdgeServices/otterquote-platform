-- RATCHET-FIXTURE: EXPECT=FAIL
-- GRANT ... TO PUBLIC gives EXECUTE to every role including anon, regardless
-- of any anon-specific REVOKE elsewhere -- must fail on its own.
BEGIN;

GRANT EXECUTE ON FUNCTION public.some_helper(uuid) TO PUBLIC;

COMMIT;
