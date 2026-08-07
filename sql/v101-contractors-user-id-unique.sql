-- ============================================================================
-- v101 — UNIQUE index on contractors.user_id (GitHub #461)
-- ============================================================================
--
-- Enforces one contractors row per auth user at the database level. Purely
-- additive: a new index, no column/table changes, no data touched.
--
-- Pre-flight verified 2026-08-07 against production: 0 duplicate non-null
-- user_id rows in public.contractors, and no existing UNIQUE index/constraint
-- on the column (only a plain non-unique btree, idx_contractors_user_id,
-- left in place — redundant now but out of scope to remove here).
--
-- NULLs are unaffected: Postgres UNIQUE indexes permit any number of NULL
-- user_id rows (contractors not yet linked to an auth user), which is the
-- correct behavior here.
-- ============================================================================

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contractors_user_id_unique
  ON public.contractors (user_id);

COMMIT;
