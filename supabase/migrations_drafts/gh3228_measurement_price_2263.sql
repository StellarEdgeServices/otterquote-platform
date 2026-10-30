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
-- Tier 3B (money). The CTO applies this after the 24-hour R-097 notice AND after the D-291 amendment exists (D-291 amendment
-- pending: do not apply before it). Full runbook, sweep query and post-apply checks: gh3228_measurement_price_2263_pre-flight.md.
--
-- BOTH keys MUST change in this one transaction. create-payment-intent prices the charge from hover_measurement_price and
-- create-measurement-order prices the order from measurement_products.roof_basic; create-measurement-order refuses the sale
-- ("price is misconfigured") when they disagree (detectPriceDrift). Do not split this into two applies.
--
-- RUNBOOK (CTO, in this order; NEVER apply this file before steps 1 and 2 are live):
--   1. Merge the PR and wait for the Netlify production deploy (static pages, react app) to go green.
--   2. Deploy the edge functions create-payment-intent (the idempotency key now includes the amount), stripe-webhook (the Meta CAPI
--      2263 guard; left stale it silently drops every Purchase), send-homeowner-next-steps and send-lead-next-step-reminder.
--   3. Apply this file within minutes, in a quiet hour. Settings first would show $15 while charging $22.63 (Terms 8.5: the fee is
--      "displayed on the measurement purchase page at the time of payment"). Code first is the safe direction.
--   4. Right after the apply (time T), cancel every OPEN 1500-cent measurement PaymentIntent (requires_payment_method,
--      requires_confirmation, requires_action). A homeowner holding one would otherwise be charged $15 and then refused.
--   5. Run the succeeded-without-order sweep over the 7 days before T through T+1h, and again at T+24h (REQUIRED, see below).
--   6. Run the post-apply checks in the pre-flight and record the results on #3228.
--   7. If the merge lands after 2026-10-30, bump the Effective Dates on terms.html and privacy.html to the deploy date. That is a
--      copy change and needs a fresh LEGAL-READ before it merges.
--
-- MID-CHECKOUT RISK (corrected): measurement PaymentIntents are captured immediately (no manual capture anywhere), and
-- create-measurement-order runs only after the PaymentIntent has succeeded. A homeowner who confirms a PaymentIntent created at
-- 1500 AFTER this apply is CHARGED $15, and the order is then refused (402: the verified amount must equal 2263), leaving no
-- hover_orders row, no report and no rebate record. Root cause fixed in code: create-payment-intent's idempotency key was
-- per claim and type for 24 hours, so a reload after the change was handed the stale $15 intent; the key now includes the amount
-- (hover_measurement-<claim_id>-<amount_cents>), so a reload creates a fresh $22.63 intent. Intents already created at 1500 are
-- cancelled in step 4; anything that still succeeded is caught by the sweep in step 5: for each succeeded measurement
-- PaymentIntent of 1500 cents with no hover_orders row, refund it in full or create its order by hand at 1500 with
-- rebate_due = true. The queries are in the pre-flight.
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
