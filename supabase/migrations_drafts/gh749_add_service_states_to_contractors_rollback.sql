-- STATUS (gh-1438, as of 2026-09-30T12:32Z): APPLIED
-- FILE ROLE: rollback file of set gh749_add_service_states_to_contractors (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: contractors.service_states live, ledger version 20260821225742, SQL byte-identical to the draft per the recorded read-back: comment 5494221280 (RW-DONE, PR #1471, supabase/migrations/MIGRATIONS-RECONCILIATION-1438.md Part 1, read-only queries 2026-09-01); ledger version 20260821225742 is in the 199-row schema_migrations snapshot recorded in supabase/migrations-reconciliation-baseline.json (queried 2026-09-29T20:55Z; comments 5902170993, 5902404090)
-- REPO COPY: supabase/migrations_rollbacks/20260821225742_gh749_add_service_states_to_contractors_rollback.sql -- same SQL statements (differs only in comments/blank lines/BEGIN/COMMIT/whitespace)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- >>> APPLIED (2026-09-26, gh-1438 part 2) -- the forward migration this
-- rollback pairs with is live, filed as
-- supabase/migrations/20260821225742_gh749_add_service_states_to_contractors.sql
-- (confirmed read-only against yeszghaspzwwstvsrioa). This rollback is
-- kept here, unmodified below this banner, for history. <<<
-- Rollback: gh749_add_service_states_to_contractors_rollback.sql
-- Reverts: gh749_add_service_states_to_contractors.sql
-- Status: DRAFT — forward migration not yet applied.
-- GitHub: #749
--
-- Purely additive forward migration (one new nullable column + a backfill
-- UPDATE confined to that same column), so rollback is a plain DROP COLUMN.
-- No guard is needed: service_states is not referenced by any FK, view,
-- RLS policy, or constraint, and dropping it cannot destroy data in
-- service_area_description or service_counties (both untouched by the
-- forward migration).

BEGIN;

ALTER TABLE public.contractors
  DROP COLUMN IF EXISTS service_states;

COMMIT;
