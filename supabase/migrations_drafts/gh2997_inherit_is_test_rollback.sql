-- STATUS (gh-1438, as of 2026-10-23T13:27:30Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2997_inherit_is_test
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: reverts gh2997_inherit_is_test.sql (the two triggers and their functions).
-- WARNING: the data correction is NOT reverted. Setting those rows back to is_test=false would re-inflate the real bid counts;
-- the corrected ids are listed in the pre-flight. Run only if a trigger must be removed in production.

BEGIN;

DROP TRIGGER IF EXISTS quotes_inherit_is_test ON public.quotes;
DROP TRIGGER IF EXISTS activity_log_inherit_is_test ON public.activity_log;
DROP FUNCTION IF EXISTS public.quotes_inherit_is_test();
DROP FUNCTION IF EXISTS public.activity_log_inherit_is_test();

COMMIT;
