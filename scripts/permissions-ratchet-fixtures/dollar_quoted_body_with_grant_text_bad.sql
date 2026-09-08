-- RATCHET-FIXTURE: EXPECT=FAIL
-- A function body (dollar-quoted) that CONTAINS the literal text
-- "GRANT ... TO anon" as a string constant, e.g. logged/raised in an error
-- message rather than executed. Rules 1-3's statement splitter correctly
-- never mistakes this for a real top-level statement -- but rule 4
-- (dynamic-sql-grant) deliberately does NOT try to distinguish "this
-- quoted/dollar-quoted span is executed as SQL" from "this span is merely
-- logged text" -- see the module docstring's DYNAMIC SQL / RULE 4 section
-- for why: telling those apart requires understanding what RAISE NOTICE,
-- EXECUTE, PERFORM etc. each do with their argument, which is a full SQL
-- interpreter, not a diff-scoped ratchet. Rule 4 fails closed on ANY
-- quoted/dollar-quoted span matching the GRANT-to-disallowed-role shape,
-- accepting this exact false positive as a known, documented, reviewable
-- (via the `permissions-ratchet: reviewed` bypass label) cost -- cheaper
-- than a real GRANT-to-anon shipping clean through a one-line EXECUTE
-- wrapper (see dynamic_sql_grant_execute_literal_bad.sql, the shape this
-- rule exists to catch).
BEGIN;

CREATE OR REPLACE FUNCTION public.some_audit_fn()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE NOTICE 'reminder: never run GRANT EXECUTE ON FUNCTION x() TO anon;';
END;
$$;

COMMIT;
