-- RATCHET-FIXTURE: EXPECT=FAIL
-- gh-1767 REVIEW: FAIL probe (g) -- a GRANT to anon wrapped in dynamic SQL
-- (DO $$ ... EXECUTE '<literal>' ... $$;) is live, executable SQL, not inert
-- audit-log text. Rules 1-3's statement splitter blanks quoted/dollar-quoted
-- content before splitting on ';', so it never sees this GRANT as a
-- statement -- rule 4 (dynamic-sql-grant) scans the raw content of every
-- quoted/dollar-quoted span for a GRANT ... TO <disallowed-role> shape
-- instead, independent of statement splitting.
BEGIN;

DO $$
BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.f() TO anon';
END
$$;

COMMIT;
