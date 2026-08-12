-- ============================================================================
-- v101 ROLLBACK — UNIQUE index on contractors.user_id (GitHub #461)
-- ============================================================================
--
-- Drops the unique index. The pre-existing non-unique idx_contractors_user_id
-- is untouched and continues to serve lookups.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS public.idx_contractors_user_id_unique;

COMMIT;
