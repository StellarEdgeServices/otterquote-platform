-- STATUS (gh-1438, as of 2026-10-19T20:58:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2442_dunning_retry_pass_lease
-- EVIDENCE: forward file not applied; see gh2442_dunning_retry_pass_lease.sql
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md (Tier 3B path: review, R-097 notice, recorded apply)
--
-- Rollback. Drops the lease table. Turn the retry pass off first (unset DUNNING_RETRY_PASS_ENABLED): without the table
-- the pass skips every tick (fails closed), so nothing breaks, but nothing retries either.
BEGIN;
DROP TABLE IF EXISTS public.dunning_retry_pass_lease;
COMMIT;
