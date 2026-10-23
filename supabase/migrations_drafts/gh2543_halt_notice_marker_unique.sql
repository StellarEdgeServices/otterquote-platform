-- STATUS (gh-1438, as of 2026-10-21): NOT APPLIED
-- FILE ROLE: forward file of set gh2543_halt_notice_marker_unique (rollback is a sibling in this directory)
-- EVIDENCE: drafted 2026-10-21 under #2543 / PR #2959 (Ben's RETURNED 6301145200 and REVIEW 6301123534, point 2). No database was read or written to produce this file. The index is on a notification_type that no code writes in production yet (the halt notices are not deployed), so no existing row can violate it; the live notifications table has no CHECK on notification_type (migration 20260925180241_gh2154_p3_partner_new_alert_trigger.sql).
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2543_halt_notice_marker_unique
-- GitHub: #2543, PR #2959. Tier: 3A additive (one partial unique index, no data change, no policy or grant change); applied only under the Tier 3B path (migration-author, review, R-097 notice, a recorded apply). Not applied by this PR.
-- Rollback: supabase/migrations_drafts/gh2543_halt_notice_marker_unique_rollback.sql
--
-- What changes: one partial unique index so two simultaneous BoldSign deliveries of the same halted envelope cannot both
-- write the send-once marker. halt-notice.ts writes one notifications row per (envelope, role) BEFORE it sends, with
-- notification_type = 'contract_halt_notice_sent' and message_preview = 'envelope=<id>;role=<homeowner|contractor>'. With this
-- index the second insert fails with SQLSTATE 23505 and that delivery sends nothing. The Edge Function already treats 23505 as
-- "already sent"; before this index is applied the function falls back to its check-then-insert and behaves as it did.
-- The index is scoped to this one notification_type so no other notification row is affected. The lock is a short SHARE lock on
-- public.notifications while the index builds; the matching row count today is zero.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_contract_halt_notice_once_idx
  ON public.notifications (message_preview)
  WHERE notification_type = 'contract_halt_notice_sent';

COMMENT ON INDEX public.notifications_contract_halt_notice_once_idx IS
'gh-2543 / PR 2959: one contract_halt_notice_sent marker per envelope+role (message_preview = envelope=<id>;role=<role>). Makes the send-once marker race-proof: the second concurrent insert fails 23505 and that delivery does not send.';

COMMIT;
