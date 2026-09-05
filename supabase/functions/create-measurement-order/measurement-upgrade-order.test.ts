import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildUpgradeOrderInsert,
  UPGRADE_INITIAL_STATUS,
  UPGRADE_PRODUCT_CODE,
  VALID_TIER_AMOUNTS_CENTS,
  VENDOR_CREDIT_EXPECTED_CENTS,
} from "./measurement-upgrade-order.ts";

Deno.test("first buyer at the $25 tier: rebate fields are written, PI id populated, status is upgrade_requested", () => {
  const decision = buildUpgradeOrderInsert(
    { amount: 2500, stripeChargeId: "ch_1" },
    "claim-1",
    "user-1",
    "contractor-1",
    "pi_upgrade_1",
    true,
    "note",
  );
  assertEquals(decision.ok, true);
  if (decision.ok) {
    assertEquals(decision.insertPayload.homeowner_charge_amount, 2500);
    assertEquals(decision.insertPayload.homeowner_stripe_payment_intent_id, "pi_upgrade_1");
    assertEquals(decision.insertPayload.vendor_credit_expected_cents, VENDOR_CREDIT_EXPECTED_CENTS);
    assertEquals(decision.insertPayload.vendor_credit_expected_cents, 1500);
    assertEquals(decision.insertPayload.status, UPGRADE_INITIAL_STATUS);
    assertEquals(decision.insertPayload.status, "awaiting_fulfillment");
    assertEquals(decision.insertPayload.product_code, UPGRADE_PRODUCT_CODE);
    assertEquals(decision.insertPayload.requested_by_role, "contractor");
    assertEquals(decision.insertPayload.requested_by_contractor_id, "contractor-1");
    assertEquals(decision.insertPayload.stripe_payment_id, "ch_1");
  }
});

Deno.test("first buyer at the $55 tier is recorded correctly too", () => {
  const decision = buildUpgradeOrderInsert(
    { amount: 5500, stripeChargeId: "ch_2" },
    "claim-2",
    "user-2",
    "contractor-2",
    "pi_upgrade_2",
    true,
    null,
  );
  assertEquals(decision.ok, true);
  if (decision.ok) {
    assertEquals(decision.insertPayload.homeowner_charge_amount, 5500);
    assertEquals(decision.insertPayload.vendor_credit_expected_cents, 1500);
  }
});

Deno.test("a LATER buyer does not carry the vendor-credit bookkeeping -- it is a one-time, first-purchase-only record (D-317 cl. 4)", () => {
  const decision = buildUpgradeOrderInsert(
    { amount: 2500, stripeChargeId: "ch_3" },
    "claim-3",
    "user-3",
    "contractor-3",
    "pi_upgrade_3",
    false,
    null,
  );
  assertEquals(decision.ok, true);
  if (decision.ok) {
    assertEquals(decision.insertPayload.vendor_credit_expected_cents, null);
  }
});

Deno.test("the PaymentIntent id is ALWAYS populated on the insert payload -- never left null for later reconciliation", () => {
  for (const amount of VALID_TIER_AMOUNTS_CENTS) {
    const decision = buildUpgradeOrderInsert(
      { amount, stripeChargeId: null },
      "claim-x",
      "user-x",
      "contractor-x",
      "pi_abc",
      true,
      null,
    );
    assertEquals(decision.ok, true);
    if (decision.ok) {
      assertEquals(decision.insertPayload.homeowner_stripe_payment_intent_id, "pi_abc");
      assertEquals(typeof decision.insertPayload.homeowner_stripe_payment_intent_id, "string");
    }
  }
});

Deno.test("a succeeded amount outside the two known tiers is refused, not silently recorded", () => {
  const decision = buildUpgradeOrderInsert(
    { amount: 1500, stripeChargeId: "ch_4" },
    "claim-4",
    "user-4",
    "contractor-4",
    "pi_upgrade_4",
    true,
    null,
  );
  assertEquals(decision.ok, false);
  if (!decision.ok) {
    assertEquals(decision.status, 402);
  }
});

Deno.test("no refund fields exist anywhere on the insert payload (R-021)", () => {
  const decision = buildUpgradeOrderInsert(
    { amount: 2500, stripeChargeId: "ch_5" },
    "claim-5",
    "user-5",
    "contractor-5",
    "pi_upgrade_5",
    true,
    null,
  );
  assertEquals(decision.ok, true);
  if (decision.ok) {
    const keys = Object.keys(decision.insertPayload);
    assertEquals(keys.some((k) => /refund/i.test(k)), false);
  }
});
