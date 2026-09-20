-- Migration: gh2055_add_notifications_suppressed_and_is_synthetic
-- Issue: #2055 -- "[2047a, tier:3a] The additive half: add the disambiguating
--        columns to `contractors` AND `leads` in ONE migration -- nothing
--        reads them yet, so nothing can email anyone"
-- Parent: #2047 -- `is_test` on contractors currently carries TWO meanings
--        ("synthetic data" AND "real party, don't email them yet"), which is
--        why every supply-side count off `is_test = false` is wrong.
-- Tier: 3a (D-182 as amended by D-261) -- purely additive: two new nullable
--        columns, no backfill, no existing column touched, no RLS/GRANT
--        change, no default that changes an existing row's meaning.
--        `tier:3a` applied to this issue by Ben (CEO RUN 56, claim
--        ceo-2026-09-20T17:37:05Z) after Kevin (Code lane) correctly
--        declined to self-apply the label.
-- Applied to production (yeszghaspzwwstvsrioa) 2026-09-20 via
--   supabase_migrations.schema_migrations version 20260920195654
--   (this file's on-disk timestamp prefix matches that applied version).
-- Rollback:   supabase/migrations_drafts/gh2055_add_notifications_suppressed_and_is_synthetic_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2055_add_notifications_suppressed_and_is_synthetic_pre-flight.md
--
-- Pre-migration live enumeration (2026-09-20, this run, pasted on #2055
-- before execution per R-147): `contractors` had 114 columns, `is_test`
-- present, `notifications_suppressed` absent. `leads` had 20 columns
-- (issue said 19 -- one more than stated, does not change scope), no
-- `is_test` and no synthetic/test-marker equivalent at all.
--
-- Column 1: contractors.notifications_suppressed -- ONE meaning only:
--   "real company, do not send them product email yet." This is the second
--   meaning currently smuggled inside contractors.is_test = true, which is
--   why Indy Rooftops, LLC and Stohler Roofing, LLC (x2) -- all real,
--   flagged test to keep them off product email -- are invisible to every
--   `where is_test = false` supply count. Nothing here reclassifies those
--   rows; contractors.is_test is not touched by this migration.
--
-- Column 2: leads.is_synthetic -- ONE meaning only: synthetic vs. real lead
--   data. Deliberately NOT named `is_test`: naming it that would reproduce,
--   on the day this ships, the exact two-meanings-one-column overload this
--   whole issue exists to remove. `is_synthetic` cannot be misread as "do
--   not email" -- that meaning lives exclusively on the other table's
--   `notifications_suppressed` column; `leads` has no notification-consent
--   column of its own to collide with.
--
-- Both columns: boolean, NULL, default NULL -- distinguishable from both
-- `true` and `false` until 2047b (out of scope here) makes a deliberate
-- backfill decision. No code, view, function, trigger, or query reads
-- either column as of this migration -- that inertness is the entire
-- tier:3a safety argument. Backfilling values, reclassifying rows, and
-- auditing the send path stay on #2047 (2047b).

BEGIN;

ALTER TABLE public.contractors
  ADD COLUMN IF NOT EXISTS notifications_suppressed boolean NULL DEFAULT NULL;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS is_synthetic boolean NULL DEFAULT NULL;

COMMIT;
