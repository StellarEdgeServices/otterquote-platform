-- STATUS (gh-1438, as of 2026-10-23T16:44:20Z): APPLIED (forward); this rollback is NOT run
-- FILE ROLE: rollback of set gh2543_halt_notice_marker_unique (forward file is a sibling in this directory)
-- EVIDENCE: APPLIED -- #2543 / Marty apply 2026-10-23T13:09Z; ledger row 20261023130943 (SELECT, project yeszghaspzwwstvsrioa); ledger statements[1] is a comment-trimmed variant of the draft, sha256 33a5716a...2e42, filed byte for byte in supabase/migrations/20261023130943_gh2543_halt_notice_marker_unique.sql. Earlier draft-time evidence, kept: drafted 2026-10-21 under #2543 / PR #2959; the forward file is not applied, so there is nothing to roll back yet. No database was read or written.
-- REPO COPY: supabase/migrations/20261023130943_gh2543_halt_notice_marker_unique.sql (forward, the ledger statement), supabase/migrations_rollbacks/20261023130943_gh2543_halt_notice_marker_unique_rollback.sql (rollback)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: gh2543_halt_notice_marker_unique. Drops the index only; no row is touched. After the drop, halt-notice.ts is back to its
-- check-then-insert guard.
BEGIN;

DROP INDEX IF EXISTS public.notifications_contract_halt_notice_once_idx;

COMMIT;
