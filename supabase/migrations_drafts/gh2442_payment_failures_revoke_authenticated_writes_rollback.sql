-- STATUS (gh-1438, as of 2026-10-14T15:20Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2442_payment_failures_revoke_authenticated_writes
-- EVIDENCE: forward file not applied; see gh2442_payment_failures_revoke_authenticated_writes.sql
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback. Gives `authenticated` back the five privileges the forward file took. Restoring TRUNCATE lets any
-- signed-in user empty the table: run this only to undo a proven breakage, and re-apply the forward file after the fix.
BEGIN;
GRANT INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.payment_failures TO authenticated;
COMMIT;
