-- STATUS (gh-1438, as of 2026-10-30T13:00:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3228_measurement_price_2263 (reverses gh3228_measurement_price_2263.sql)
-- EVIDENCE: not applied; the forward file is not applied either (production read 1500 / 1500 on 2026-10-30)
-- REPO COPY: none in supabase/migrations_rollbacks/ yet
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Restores the homeowner measurement fee to $15 (1500 cents) in BOTH keys, in one transaction (the two must agree, see the forward
-- file). Run only if the forward file was applied. Orders already charged 2263 keep their recorded hover_orders.homeowner_charge_amount
-- and are still rebated at 2263 (the rebate refunds what was charged). If the code half (the PR carrying this file) is also rolled
-- back, roll it back in the same window; the copy and the Meta CAPI amount guard otherwise disagree with the price.
BEGIN;

DO $$
DECLARE
  v_legacy   jsonb;
  v_catalog  jsonb;
BEGIN
  SELECT value INTO v_legacy  FROM public.platform_settings WHERE key = 'hover_measurement_price';
  SELECT value INTO v_catalog FROM public.platform_settings WHERE key = 'measurement_products';
  IF v_legacy IS NULL OR v_catalog IS NULL THEN
    RAISE EXCEPTION 'gh3228 rollback precondition failed: hover_measurement_price or measurement_products missing';
  END IF;
  IF v_legacy <> to_jsonb(2263) OR (v_catalog #> '{roof_basic,homeowner_price_cents}') <> to_jsonb(2263) THEN
    RAISE EXCEPTION 'gh3228 rollback precondition failed: expected both prices 2263, found legacy=% catalog=%',
      v_legacy, v_catalog #> '{roof_basic,homeowner_price_cents}';
  END IF;

  UPDATE public.platform_settings SET value = to_jsonb(1500), updated_at = now() WHERE key = 'hover_measurement_price';
  UPDATE public.platform_settings
     SET value = jsonb_set(value, '{roof_basic,homeowner_price_cents}', to_jsonb(1500)), updated_at = now()
   WHERE key = 'measurement_products';

  IF (SELECT value FROM public.platform_settings WHERE key = 'hover_measurement_price') <> to_jsonb(1500)
     OR (SELECT value #> '{roof_basic,homeowner_price_cents}' FROM public.platform_settings WHERE key = 'measurement_products') <> to_jsonb(1500) THEN
    RAISE EXCEPTION 'gh3228 rollback postcondition failed: prices do not both read 1500';
  END IF;
END $$;

COMMIT;
