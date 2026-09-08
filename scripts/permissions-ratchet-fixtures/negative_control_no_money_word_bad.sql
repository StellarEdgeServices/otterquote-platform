-- RATCHET-FIXTURE: EXPECT=FAIL
-- The issue's own negative control: no money word anywhere in this
-- identifier, so R-120's money-permission branch (scripts/r177/predicate.mjs)
-- structurally cannot catch it. This ratchet must, on authorisation grounds
-- alone.
BEGIN;

GRANT EXECUTE ON FUNCTION public.admin_delete_user() TO anon;

COMMIT;
