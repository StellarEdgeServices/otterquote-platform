-- gh1028_add_is_test_to_activity_log_rollback.sql
-- Rollback for: 20260818204945_gh1028_add_is_test_to_activity_log.sql
-- GitHub: #1028
--
-- Additive/nullable-equivalent column, no data destroyed by the forward migration
-- itself. Dropping it also discards the harness backfill (sql/2026-08-18-flag-
-- harness-bids-1028.sql) and the view predicate changes in the same PR revert
-- with it structurally (the views reference is_test; drop the column only after
-- reverting the view definitions, or this will error).

BEGIN;

ALTER TABLE public.activity_log
  DROP COLUMN IF EXISTS is_test;

COMMIT;
