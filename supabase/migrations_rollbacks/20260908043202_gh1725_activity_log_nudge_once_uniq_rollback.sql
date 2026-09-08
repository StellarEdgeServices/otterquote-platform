-- ROLLBACK for 20260908043202_gh1725_activity_log_nudge_once_uniq.sql
--
-- CREATE INDEX CONCURRENTLY does not roll back automatically on failure -- it
-- can leave an INVALID index behind (visible via `select indisvalid from
-- pg_index where indexrelid = 'activity_log_nudge_once_uniq'::regclass`).
-- If a retry of the forward migration is needed after a failed run, DROP
-- first with this file, then re-run the forward migration; do not assume the
-- failed attempt cleaned up after itself.
--
-- DROP INDEX CONCURRENTLY (like CREATE INDEX CONCURRENTLY) cannot run inside
-- a transaction block, so this file intentionally carries no BEGIN/COMMIT
-- wrapper.
--
-- Dropping this index does NOT break send-homeowner-next-steps: its 23505
-- catch (index.ts:534) simply becomes unreachable again, which is the
-- pre-migration state. It reverts a guard, it does not remove a dependency.

DROP INDEX CONCURRENTLY IF EXISTS activity_log_nudge_once_uniq;
