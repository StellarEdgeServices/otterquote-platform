-- STATUS (gh-1438, as of 2026-10-30T13:00:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3228_measurement_price_2263 (rollback: gh3228_measurement_price_2263_rollback.sql, same directory)
-- EVIDENCE: production read-only SELECT 2026-10-30 (project yeszghaspzwwstvsrioa): platform_settings.hover_measurement_price = 1500 and measurement_products.roof_basic.homeowner_price_cents = 1500; not applied by this PR
-- REPO COPY: none in supabase/migrations/ yet
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-3228 / P18: homeowner aerial measurement fee $15 -> $22.63 (Dustin, chat 2026-10-30 09:17 ET: "bump the price of the
-- measurement up to $22.63."). Still rebated on job completion (D-291); the rebate refunds hover_orders.homeowner_charge_amount
-- (what was charged), so it follows this price with no code change.
--
-- Tier 3B (money). The CTO applies this AFTER the 24-hour R-097 notice, together with the deploy of the PR that carries it.
-- A D-291 amendment is being drafted separately; do not apply before it exists.
--
-- BOTH keys MUST change in this one transaction. create-payment-intent prices the charge from hover_measurement_price and
-- create-measurement-order prices the order from measurement_products.roof_basic; create-measurement-order refuses the sale
-- ("price is misconfigured") when they disagree (detectPriceDrift). Do not split this into two applies.
--
-- Timing note for the CTO: a homeowner who loaded the payment form before the apply holds a PaymentIntent at 1500; the order
-- call verifies the PaymentIntent against the NEW price and refuses it, nothing is fulfilled, and the homeowner retries (the
-- card is then charged 2263; the old 1500 authorisation is the homeowner's to see lapse). Apply in a quiet hour.
-- Not changed: roof_full / exterior_full (contractor-priced, homeowner_price_cents null), expected_vendor_cost_cents, rebate_on_close.
BEGIN;

DO $$
DECLARE
  v_legacy   jsonb;
  v_catalog  jsonb;
BEGIN
  SELECT value INTO v_legacy  FROM public.platform_settings WHERE key = 'hover_measurement_price';
  SELECT value INTO v_catalog FROM public.platform_settings WHERE key = 'measurement_products';

  -- PRECONDITION: both keys exist and both still say 1500. Anything else means someone changed it; stop and look.
  IF v_legacy IS NULL OR v_catalog IS NULL THEN
    RAISE EXCEPTION 'gh3228 precondition failed: hover_measurement_price or measurement_products missing';
  END IF;
  IF v_legacy <> to_jsonb(1500) OR (v_catalog #> '{roof_basic,homeowner_price_cents}') <> to_jsonb(1500) THEN
    RAISE EXCEPTION 'gh3228 precondition failed: expected both prices 1500, found legacy=% catalog=%',
      v_legacy, v_catalog #> '{roof_basic,homeowner_price_cents}';
  END IF;

  UPDATE public.platform_settings
     SET value = to_jsonb(2263), updated_at = now()
   WHERE key = 'hover_measurement_price';

  UPDATE public.platform_settings
     SET value = jsonb_set(value, '{roof_basic,homeowner_price_cents}', to_jsonb(2263)), updated_at = now()
   WHERE key = 'measurement_products';

  -- POSTCONDITION: both read 2263 and the two agree.
  IF (SELECT value FROM public.platform_settings WHERE key = 'hover_measurement_price') <> to_jsonb(2263)
     OR (SELECT value #> '{roof_basic,homeowner_price_cents}' FROM public.platform_settings WHERE key = 'measurement_products') <> to_jsonb(2263) THEN
    RAISE EXCEPTION 'gh3228 postcondition failed: prices do not both read 2263';
  END IF;
END $$;

COMMIT;
