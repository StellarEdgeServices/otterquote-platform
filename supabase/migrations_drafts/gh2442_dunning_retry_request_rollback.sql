-- STATUS (gh-1438, as of 2026-10-07T22:44Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2442_dunning_retry_request (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: forward file not applied; see gh2442_dunning_retry_request.sql
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback for gh2442_dunning_retry_request. Run by hand, only after the forward file was applied.
-- Drops the function and the two columns; the CHECK on retry_request_count goes with its column (any stored retry
-- requests and their counts are lost; nothing else reads
-- them until the retry pass ships, and if that has shipped, roll that back first).
-- It does NOT restore the UPDATE, TRUNCATE and TRIGGER permissions the forward file took from the logged-out role
-- (anon) on payment_failures: nothing uses them, and a rollback must not hand a logged-out visitor write
-- permissions on a money table (PR #2579 comment 6029194857, item 3). After this rollback the table's permissions
-- therefore differ from the pre-migration state by exactly those three, on purpose.
-- It does not touch `authenticated`'s table permissions either way (INSERT, UPDATE, DELETE, TRUNCATE stay as they
-- were before, after and after rollback); that revoke is a separate change, not part of this set.
BEGIN;
DROP FUNCTION IF EXISTS public.request_dunning_retry(uuid);
ALTER TABLE public.payment_failures DROP COLUMN IF EXISTS retry_request_count;
ALTER TABLE public.payment_failures DROP COLUMN IF EXISTS retry_requested_at;
COMMIT;
