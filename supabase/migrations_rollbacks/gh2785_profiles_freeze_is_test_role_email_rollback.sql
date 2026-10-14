-- STATUS (gh-1438, as of 2026-10-14T15:58:46Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2785_profiles_freeze_is_test_role_email (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: written by gh-2785; the forward file creates exactly the two objects dropped here and changes nothing else
-- REPO COPY: none in supabase/migrations/ (this is a manual reference rollback)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2785 ROLLBACK for supabase/migrations_drafts/gh2785_profiles_freeze_is_test_role_email.sql
--
-- Manual reference only. Never rename this into a 14-digit timestamp or move it into supabase/migrations/ -- the CLI
-- would replay it FORWARD and undo the guard it exists to revert. Drops the trigger and its function only. Rolling back
-- re-opens the browser write of profiles.is_test, role and email. No data is touched. If the forward file was applied
-- through the ledger, also delete its supabase_migrations.schema_migrations row.

BEGIN;

DROP TRIGGER IF EXISTS profiles_freeze_privileged_columns ON public.profiles;
DROP FUNCTION IF EXISTS public.profiles_freeze_privileged_columns();

COMMIT;
