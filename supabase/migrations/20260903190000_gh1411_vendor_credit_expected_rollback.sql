-- ============================================================================
-- gh1411_vendor_credit_expected — ROLLBACK
--
-- Safe to run ONLY while nothing reads or writes this column — i.e. before
-- create-payment-intent / create-measurement-order's measurement_upgrade
-- branches are live, or after they have been rolled back first. Dropping the
-- column IS destructive: any recorded vendor-credit bookkeeping is lost.
-- Verify the guard SELECT at the bottom returns 0 before running this in an
-- environment with real rows.
-- ============================================================================

ALTER TABLE public.hover_orders
  DROP COLUMN IF EXISTS vendor_credit_expected_cents;

-- Guard to run BEFORE the statement above in any environment with data:
--   SELECT count(*) FROM public.hover_orders
--    WHERE vendor_credit_expected_cents IS NOT NULL;
--   -- must be 0, or this rollback destroys vendor-credit bookkeeping.
