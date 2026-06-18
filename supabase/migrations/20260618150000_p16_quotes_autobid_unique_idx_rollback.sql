-- Rollback: 20260618150000_p16_quotes_autobid_unique_idx_rollback.sql
-- Reverts: 20260618150000_p16_quotes_autobid_unique_idx.sql
-- Author: Claude Code (Opus 4.8) — D-211 Phase 16, Unit 0
-- Date: 2026-06-18
--
-- Drops the quotes_autobid_unique_idx partial unique index. Idempotent (IF EXISTS).
--
-- NOTE: After this rollback the process-auto-bids Edge Function loses its durable
--       dedupe backstop; concurrent ~5-min cron runs could again race a duplicate
--       auto-bid. The EF's 23505 handler simply never fires without the index — it
--       does not error, so the EF need not be rolled back in lockstep.

BEGIN;

DROP INDEX IF EXISTS public.quotes_autobid_unique_idx;

COMMIT;
