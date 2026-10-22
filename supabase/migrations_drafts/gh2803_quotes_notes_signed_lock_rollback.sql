-- Rollback for supabase/migrations_drafts/gh2803_quotes_notes_signed_lock.sql (gh-2803).
-- Removes the signed-notes trigger and its function; nothing else. Returns to the state where a client caller can change notes on a signed bid
-- (the hole PR #2844 review 6254508202 found). No data is lost. quotes_guard_homeowner_columns() is not touched, so this is safe in any order with gh2564/gh2626/gh2519.
-- If the migration was applied, also delete its supabase_migrations.schema_migrations row.
BEGIN;

DROP TRIGGER IF EXISTS quotes_refuse_signed_notes_change ON public.quotes;
DROP FUNCTION IF EXISTS public.quotes_refuse_signed_notes_change();

COMMIT;
