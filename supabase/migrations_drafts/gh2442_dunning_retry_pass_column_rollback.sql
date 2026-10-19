-- STATUS (gh-1438, as of 2026-10-19T19:32:54Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2442_dunning_retry_pass_column
-- EVIDENCE: forward file not applied; see gh2442_dunning_retry_pass_column.sql
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback. Drops the column. Turn the retry pass off first (unset DUNNING_RETRY_PASS_ENABLED) or the pass will
-- throw inside its own try/catch each tick (reminders unaffected). Loses only the consumed stamps and unknown-outcome markers (check no row has retry_unknown_at set first: such a quote may hold an unreconciled Stripe charge).
BEGIN;
ALTER TABLE public.payment_failures DROP COLUMN IF EXISTS retry_handled_at;
ALTER TABLE public.payment_failures DROP COLUMN IF EXISTS retry_unknown_at;
COMMIT;
