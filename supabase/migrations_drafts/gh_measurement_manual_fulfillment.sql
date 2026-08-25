-- ============================================================================
-- gh_measurement_manual_fulfillment — FORWARD
--
-- Tier 3A (additive only): nine nullable columns and one partial index on
-- public.hover_orders. No column is dropped, renamed, retyped or narrowed;
-- no CHECK constraint is touched; no data is rewritten. Nothing reads or
-- writes these columns until the create-measurement-order Edge Function and
-- admin-measurements.html ship, which are a separate, separately-tiered step.
--
-- WHY: Dustin's 2026-08-24 directive — the homeowner buys a measurement on
-- the site, Otter Quotes orders it from the vendor out-of-band, and an admin
-- enters the result by hand for the first several runs. The existing
-- create-hover-order path calls a vendor API synchronously and cannot express
-- "paid, ordered by a human, not yet delivered." These columns give that
-- lifecycle a home on the table that already models measurement orders.
--
-- TABLE NAME: public.hover_orders keeps its vendor-branded name in this
-- migration ON PURPOSE. Renaming a table that ~10 Edge Functions and two
-- frontends reference is destructive (Tier 3B) and has nothing to do with
-- the capability being added. The rename is tracked separately.
--
-- PRE-VERIFIED LIVE 2026-08-24 against yeszghaspzwwstvsrioa:
--   28 columns, none of the nine below present; 0 rows in the table, ever.
-- ============================================================================

ALTER TABLE public.hover_orders
  -- Which SKU was bought. Null on legacy/API-path rows. Values are the keys
  -- of platform_settings.measurement_products (see the seed below), NOT a
  -- CHECK constraint — the catalog is operator-editable without a deploy.
  ADD COLUMN IF NOT EXISTS product_code text,
  -- 'manual' = a human orders from the vendor and enters the result.
  -- 'api'    = the legacy synchronous vendor-API path.
  ADD COLUMN IF NOT EXISTS fulfillment_mode text,
  -- The vendor's own order/report number, typed in by the fulfilling admin.
  ADD COLUMN IF NOT EXISTS vendor_order_ref text,
  -- What WE paid the vendor, in cents. This is the column that makes real
  -- per-order margin observable from order one instead of estimated.
  ADD COLUMN IF NOT EXISTS vendor_cost_cents integer,
  ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz,
  ADD COLUMN IF NOT EXISTS fulfilled_by uuid,
  -- 'homeowner' | 'contractor' | 'admin' — who asked for this report.
  -- A contractor-requested full report is a different money flow from a
  -- homeowner-purchased basic one and must be distinguishable on the row.
  ADD COLUMN IF NOT EXISTS requested_by_role text,
  ADD COLUMN IF NOT EXISTS requested_by_contractor_id uuid,
  ADD COLUMN IF NOT EXISTS admin_notes text;

COMMENT ON COLUMN public.hover_orders.product_code IS
  'Measurement SKU key from platform_settings.measurement_products. Deliberately not CHECK-constrained: the catalog is operator-editable.';
COMMENT ON COLUMN public.hover_orders.vendor_cost_cents IS
  'What Otter Quotes paid the measurement vendor for this order, in cents. Entered by the fulfilling admin. Makes per-order margin observable.';
COMMENT ON COLUMN public.hover_orders.fulfillment_mode IS
  'manual = human orders from the vendor and enters the result; api = legacy synchronous vendor-API path.';

-- The admin fulfillment queue's only query: everything paid and not yet
-- delivered, oldest first. Partial so it stays tiny regardless of table size.
CREATE INDEX IF NOT EXISTS idx_hover_orders_awaiting_fulfillment
  ON public.hover_orders (created_at)
  WHERE status = 'awaiting_fulfillment';

-- Seed the product catalog. ON CONFLICT DO NOTHING so re-running never
-- overwrites prices an operator has since edited in the admin panel.
--
-- Prices reflect Dustin's 2026-08-24 ruling: the homeowner pays $15 for the
-- condensed roof report and that is expected to be enough to bid most jobs;
-- a contractor who needs the full report pays for that themselves. The
-- contractor SKUs are seeded with homeowner_price_cents = null, which the
-- UI renders as "request a quote" rather than a buy button — deliberate,
-- because charging a contractor is a money flow Dustin has not priced yet.
INSERT INTO public.platform_settings (key, value)
VALUES (
  'measurement_products',
  jsonb_build_object(
    'roof_basic', jsonb_build_object(
      'label', 'Roof Measurement Report',
      'blurb', 'Aerial roof measurements — squares, pitch, facets, ridge, hip, valley and eave lengths. Enough for a contractor to bid most roofing jobs.',
      'scope', 'roof',
      'buyer', 'homeowner',
      'homeowner_price_cents', 1500,
      'expected_vendor_cost_cents', 1100,
      'rebate_on_close', true,
      'default_for_trades', jsonb_build_array('roofing'),
      'active', true
    ),
    'roof_full', jsonb_build_object(
      'label', 'Full Roof Report',
      'blurb', 'The complete roof report, including the detail some contractors need for complex or multi-layer jobs.',
      'scope', 'roof',
      'buyer', 'contractor',
      'homeowner_price_cents', null,
      'expected_vendor_cost_cents', 4000,
      'rebate_on_close', false,
      'default_for_trades', jsonb_build_array(),
      'active', true
    ),
    'exterior_full', jsonb_build_object(
      'label', 'Full Exterior Report',
      'blurb', 'Roof plus walls, openings and gutters — required to bid siding, window and gutter work accurately.',
      'scope', 'exterior',
      'buyer', 'contractor',
      'homeowner_price_cents', null,
      'expected_vendor_cost_cents', 5500,
      'rebate_on_close', false,
      'default_for_trades', jsonb_build_array('siding', 'windows', 'gutters'),
      'active', true
    )
  )
)
ON CONFLICT (key) DO NOTHING;
