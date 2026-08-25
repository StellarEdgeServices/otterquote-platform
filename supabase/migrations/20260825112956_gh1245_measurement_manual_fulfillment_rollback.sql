-- ============================================================================
-- gh_measurement_manual_fulfillment — ROLLBACK
--
-- Safe to run ONLY while nothing reads or writes these columns — i.e. before
-- create-measurement-order and admin-measurements.html are live, or after
-- they have been rolled back first. Dropping a column IS destructive: any
-- fulfillment data an admin has entered is destroyed. Verify the SELECT at
-- the bottom returns 0 before running this in an environment with real rows.
-- ============================================================================

DROP INDEX IF EXISTS public.idx_hover_orders_awaiting_fulfillment;

ALTER TABLE public.hover_orders
  DROP COLUMN IF EXISTS product_code,
  DROP COLUMN IF EXISTS fulfillment_mode,
  DROP COLUMN IF EXISTS vendor_order_ref,
  DROP COLUMN IF EXISTS vendor_cost_cents,
  DROP COLUMN IF EXISTS fulfilled_at,
  DROP COLUMN IF EXISTS fulfilled_by,
  DROP COLUMN IF EXISTS requested_by_role,
  DROP COLUMN IF EXISTS requested_by_contractor_id,
  DROP COLUMN IF EXISTS admin_notes;

DELETE FROM public.platform_settings WHERE key = 'measurement_products';

-- Guard to run BEFORE the statements above in any environment with data:
--   SELECT count(*) FROM public.hover_orders
--    WHERE product_code IS NOT NULL OR vendor_order_ref IS NOT NULL
--       OR vendor_cost_cents IS NOT NULL OR fulfilled_at IS NOT NULL;
--   -- must be 0, or this rollback destroys fulfillment records.
