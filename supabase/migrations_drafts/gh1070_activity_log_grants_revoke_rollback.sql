-- STATUS (gh-1438, as of 2026-09-30T12:32Z): NOT APPLIED (this file's SQL). The anon revoke EFFECT is live via a different, shorter migration
-- FILE ROLE: rollback file of set gh1070_activity_log_grants_revoke (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: anon has zero privileges on public.activity_log but the SQL that ran is 20260824183229_gh1070_revoke_anon_activity_log: comment 5494221280 (RW-DONE, PR #1471, supabase/migrations/MIGRATIONS-RECONCILIATION-1438.md Part 1, read-only queries 2026-09-01); ledger version 20260824183229 is in the 199-row schema_migrations snapshot recorded in supabase/migrations-reconciliation-baseline.json (queried 2026-09-29T20:55Z; comments 5902170993, 5902404090)
-- REPO COPY: none in supabase/migrations/ or supabase/migrations_rollbacks/ for this file (_rollback.sql/_pre-flight.md: no copy filed on purpose (they target this draft's broader design, not what ran))
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- >>> SUPERSEDED (2026-09-26, gh-1438 part 2) -- the migration that actually
-- ran under a #1070 name is supabase/migrations/20260824183229_gh1070_revoke_anon_activity_log.sql,
-- structurally different from and much shorter than this draft's forward
-- file (see that file's own banner). This rollback does not pair with
-- anything that ran. Kept here, unmodified below this banner, for
-- history. <<<
-- Rollback: gh1070_activity_log_grants_revoke_rollback.sql
-- Reverts: gh1070_activity_log_grants_revoke.sql
-- Status: DRAFT — forward migration not yet applied.
-- GitHub: #1070
--
-- Restores the exact pre-migration grant set and INSERT policy check,
-- verified against the live definitions read this session (2026-08-21),
-- not reconstructed from memory. No guard/abort condition is needed here
-- (unlike gh1021's paid-row guard) — re-granting privileges and loosening
-- a with_check clause back to its original form cannot destroy data or
-- violate a narrower constraint against existing rows.

BEGIN;

-- Restore original with_check (drops the is_test = false requirement added
-- by the forward migration).
ALTER POLICY "Users can insert own activity" ON public.activity_log
  WITH CHECK (((SELECT auth.uid()) = user_id));

-- Restore anon's original full grant set (live-verified pre-migration state).
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
  ON public.activity_log TO anon;

-- Restore authenticated's original full grant set (SELECT and INSERT were
-- never revoked by the forward migration; this re-adds the other five).
GRANT DELETE, REFERENCES, TRIGGER, TRUNCATE, UPDATE
  ON public.activity_log TO authenticated;

COMMIT;
