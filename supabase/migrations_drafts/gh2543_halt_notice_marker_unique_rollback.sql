-- STATUS (gh-1438, as of 2026-10-21): NOT APPLIED
-- FILE ROLE: rollback of set gh2543_halt_notice_marker_unique (forward file is a sibling in this directory)
-- EVIDENCE: drafted 2026-10-21 under #2543 / PR #2959; the forward file is not applied, so there is nothing to roll back yet. No database was read or written.
-- REPO COPY: none. When the forward is applied, move this file to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: gh2543_halt_notice_marker_unique. Drops the index only; no row is touched. After the drop, halt-notice.ts is back to its
-- check-then-insert guard.
BEGIN;

DROP INDEX IF EXISTS public.notifications_contract_halt_notice_once_idx;

COMMIT;
