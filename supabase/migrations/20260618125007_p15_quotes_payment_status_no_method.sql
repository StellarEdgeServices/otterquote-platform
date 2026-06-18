-- Migration: 20260618125007_p15_quotes_payment_status_no_method
-- Author: Claude Code (Opus 4.8) — D-211 Phase 15, Unit U15-2
-- Date: 2026-06-18
-- D-numbers: D-182 (Tier 3 deploy), D-211 P15 (docusign-webhook revenue-path hardening)
-- Rollback: 20260618125007_p15_quotes_payment_status_no_method_rollback.sql
--
-- Summary: ADDITIVE — extends the quotes_payment_status_check constraint to allow a
--          new 'no_method' value WITHOUT removing any existing value. This lets the
--          docusign-webhook Edge Function record a distinct signed-but-unbilled state
--          when the winning contractor has no Stripe card on file at contract-signing
--          time (pre-charge), separate from 'dunning' (a charge was attempted and the
--          card declined).
--
--          Current constraint (set by sql/v37-switch-contractor.sql):
--            CHECK (payment_status IN ('succeeded','failed','pending','dunning','refunded'))
--          After this migration:
--            CHECK (payment_status IN ('succeeded','failed','pending','dunning','refunded','no_method'))
--
--          No table rewrite. The constraint swap takes a brief ACCESS EXCLUSIVE lock
--          on quotes for the catalog update plus a one-time validation scan of existing
--          rows; every current value remains valid, so validation cannot fail.

BEGIN;

-- Drop the existing constraint (if present) and recreate it with 'no_method' added.
-- Idempotent: the drop is guarded by pg_constraint existence and the re-add is total.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quotes_payment_status_check'
  ) THEN
    ALTER TABLE quotes DROP CONSTRAINT quotes_payment_status_check;
  END IF;

  ALTER TABLE quotes ADD CONSTRAINT quotes_payment_status_check
    CHECK (payment_status IN ('succeeded', 'failed', 'pending', 'dunning', 'refunded', 'no_method'));
END $$;

COMMIT;
