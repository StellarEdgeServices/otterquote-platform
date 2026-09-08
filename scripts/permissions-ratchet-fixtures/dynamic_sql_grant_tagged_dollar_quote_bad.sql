-- RATCHET-FIXTURE: EXPECT=FAIL
-- Same evasion as dynamic_sql_grant_execute_literal_bad.sql, but the outer
-- DO block uses TAGGED dollar-quoting ($q$...$q$) instead of the bare $$
-- delimiter. Rule 4 must not depend on the specific tag -- strip_noise's
-- own _DOLLAR_TAG_RE already handles arbitrary tags for statement-splitting
-- purposes, and the literal-span collector reuses that same matcher.
BEGIN;

DO $q$
BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.f() TO anon';
END
$q$;

COMMIT;
