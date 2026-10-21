-- Rollback for supabase/migrations_drafts/gh2803_selected_bid_notes_rpc.sql (gh-2803, D-381).
-- Removes the notes-only save path. A selected contractor can no longer edit notes (the state after PR #2802). No data is lost: notes already saved stay on the quotes.
-- The bid-form block that calls it is a separate revertible commit; until that is reverted its Save button shows the save-failed error.
-- If the migration was applied, also delete its supabase_migrations.schema_migrations row.
BEGIN;

DROP FUNCTION IF EXISTS public.update_selected_bid_notes(uuid, text);

COMMIT;
