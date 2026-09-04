-- ROLLBACK for 20260903184350_gh1544_contractors_email_lower_uniq.sql
--
-- CREATE INDEX CONCURRENTLY does not roll back automatically on failure --
-- it can leave an INVALID index behind (visible via `select indisvalid from
-- pg_index where indexrelid = 'contractors_email_lower_uniq'::regclass`).
-- If a retry of the forward migration is needed after a failed run, DROP
-- first with this file, then re-run the forward migration; do not assume
-- the failed attempt cleaned up after itself.
--
-- DROP INDEX CONCURRENTLY (like CREATE INDEX CONCURRENTLY) cannot run
-- inside a transaction block, so this file intentionally carries no
-- BEGIN/COMMIT wrapper.

DROP INDEX CONCURRENTLY IF EXISTS contractors_email_lower_uniq;
