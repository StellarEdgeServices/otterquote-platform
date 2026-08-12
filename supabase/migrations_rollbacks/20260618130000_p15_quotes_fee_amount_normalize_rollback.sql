-- Rollback: 20260618130000_p15_quotes_fee_amount_normalize_rollback.sql
-- Reverts: 20260618130000_p15_quotes_fee_amount_normalize.sql
-- Author: Claude Code (Opus 4.8) — D-211 Phase 15, Unit MIG-C (U15-4 Part 1)
-- Date: 2026-06-18
--
-- Removes the fee_amount normalization trigger and its function. Idempotent (IF EXISTS).
--
-- NOTE: This intentionally does NOT revert the one-time backfill. The backfill only
--       corrected fee_amount to equal the charge basis (platform_fee_pct% × total_price);
--       that data is correct on its own merits, and there is no prior per-row value to
--       restore. After this rollback, fee_amount simply stops being auto-maintained and
--       reverts to whatever the application writes — exactly the pre-migration behavior.

BEGIN;

DROP TRIGGER IF EXISTS quotes_normalize_fee_amount ON public.quotes;
DROP FUNCTION IF EXISTS public.normalize_quotes_fee_amount();

COMMIT;
