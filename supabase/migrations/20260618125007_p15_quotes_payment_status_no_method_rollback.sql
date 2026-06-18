-- Rollback: 20260618125007_p15_quotes_payment_status_no_method_rollback.sql
-- Reverts: 20260618125007_p15_quotes_payment_status_no_method.sql
-- Author: Claude Code (Opus 4.8) — D-211 Phase 15, Unit U15-2
-- Date: 2026-06-18
--
-- Restores the prior quotes_payment_status_check constraint (without 'no_method'),
-- i.e. the v37 state: CHECK (payment_status IN
--   ('succeeded','failed','pending','dunning','refunded')).
--
-- WARNING: This rollback WILL FAIL if any quotes row already holds
--          payment_status = 'no_method' at execution time — the re-added CHECK is
--          validated against existing data and ADD CONSTRAINT aborts on violation.
--          Before rolling back, first migrate any 'no_method' rows to a permitted
--          value (per CTO direction) and only then run this file.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quotes_payment_status_check'
  ) THEN
    ALTER TABLE quotes DROP CONSTRAINT quotes_payment_status_check;
  END IF;

  ALTER TABLE quotes ADD CONSTRAINT quotes_payment_status_check
    CHECK (payment_status IN ('succeeded', 'failed', 'pending', 'dunning', 'refunded'));
END $$;

COMMIT;
