-- ROLLBACK for gh1796_claims_loss_sheet_reviewed_at (#1796).
--
-- ⚠ ORDER MATTERS, but in the gentle direction: the readers of this column were
-- written to survive its absence, so a schema-only rollback does NOT break the
-- admin page.
--   get-homeowner-list        -> reports loss_sheet_reviewed_column_present: false
--                                and every claim reads as unreviewed. The queue
--                                shows MORE rows, never fewer, and never errors.
--   mark-loss-sheet-reviewed  -> returns 503 { migration_pending: true } and
--                                writes nothing. The button reports it, fails
--                                closed, and changes no data.
--   admin-homeowners.html     -> renders the queue and surfaces that notice.
-- So this can be run before or after rolling the Edge Functions back. Rolling the
-- functions back FIRST is still tidier, because it removes the button before the
-- column it writes disappears.
--
-- WHAT IS LOST: every "I reviewed this loss sheet" mark Dustin has set. Those are
-- NOT recoverable from the column afterwards. They ARE recoverable from
-- activity_log, which mark-loss-sheet-reviewed writes in the same call:
--
--   SELECT metadata->>'claim_id' AS claim_id, created_at
--     FROM activity_log
--    WHERE event_type = 'loss_sheet_reviewed'
--    ORDER BY created_at;
--
-- Run that and keep the output BEFORE running the DROP if the marks matter. Note
-- the audit row is skipped for a claim with a NULL user_id (activity_log.user_id
-- is NOT NULL), so the recovery is best-effort, not complete.
--
-- Nothing else in the schema depends on this column: no index, no constraint, no
-- trigger, no view, no RLS policy, no generated column, no foreign key.

BEGIN;

ALTER TABLE public.claims
  DROP COLUMN IF EXISTS loss_sheet_reviewed_at;

COMMIT;
