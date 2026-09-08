-- RATCHET-FIXTURE: EXPECT=PASS LABELS=permissions-ratchet: reviewed
-- Same dangerous shape as grant_anon_bad.sql, but this PR carries the
-- bypass label -- must PASS, with the finding still printed as BYPASSED
-- (checked separately by the caller; --self-test only asserts the verdict).
BEGIN;

GRANT EXECUTE ON FUNCTION public.some_reporting_helper() TO anon;

COMMIT;
