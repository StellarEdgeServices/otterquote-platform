-- STATUS (gh-1438, as of 2026-10-19): NOT APPLIED
-- FILE ROLE: rollback file of set gh2819_quotes_client_select_refused (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: forward file not applied; see gh2819_quotes_client_select_refused.sql
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback for gh2819_quotes_client_select_refused. Run by hand, only after the forward file was applied.
-- WARNING: this RE-OPENS the direct write: a homeowner session can again set quotes.status = 'selected' without accept_bid().
-- The forward file did not change quotes_guard_homeowner_columns() or any data, so nothing else needs restoring. If the
-- migration was applied, also delete its supabase_migrations.schema_migrations row.
BEGIN;

DROP TRIGGER IF EXISTS quotes_refuse_client_select_status ON public.quotes;
DROP FUNCTION IF EXISTS public.quotes_refuse_client_select_status();

COMMIT;
