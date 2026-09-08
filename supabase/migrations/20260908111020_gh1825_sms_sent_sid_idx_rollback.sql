-- ROLLBACK for 20260908111020_gh1825_sms_sent_sid_idx.sql
--
-- CREATE INDEX CONCURRENTLY does not roll back automatically on failure --
-- it can leave an INVALID index behind (visible via `select indisvalid from
-- pg_index where indexrelid = 'activity_log_sms_sent_sid_idx'::regclass`).
-- If a retry of the forward migration is needed after a failed run, DROP
-- first with this file, then re-run the forward migration.
--
-- DROP INDEX CONCURRENTLY (like CREATE INDEX CONCURRENTLY) cannot run
-- inside a transaction block, so this file intentionally carries no
-- BEGIN/COMMIT wrapper.
--
-- Dropping this index does NOT break send-sms's activity_log write or
-- platform-health-check's Phase 4 alarm: the write still succeeds (it is a
-- plain insert into an existing jsonb column) and Phase 4 reads Twilio
-- directly, not this index. It only makes a future SID-keyed lookup against
-- activity_log slower (sequential scan instead of index scan).

DROP INDEX CONCURRENTLY IF EXISTS activity_log_sms_sent_sid_idx;
