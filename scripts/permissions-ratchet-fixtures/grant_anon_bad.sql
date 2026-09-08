-- RATCHET-FIXTURE: EXPECT=FAIL
-- Baseline dangerous case: GRANT EXECUTE to anon on a function. This is the
-- exact shape gh-1767 exists to catch and R-120's money-permission branch
-- structurally cannot (no money word in the identifier).
BEGIN;

GRANT EXECUTE ON FUNCTION public.some_reporting_helper() TO anon;

COMMIT;
