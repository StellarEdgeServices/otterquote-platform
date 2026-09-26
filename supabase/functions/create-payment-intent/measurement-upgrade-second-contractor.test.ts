/**
 * [gh-1411, 2026-09-26] Second-contractor negative control, end to end at the
 * code level.
 *
 * The gate module's own test suite (measurement-upgrade-gate.test.ts) locks
 * the "already-detailed no-mint" case in isolation. This file composes that
 * same pure gate with the admin-fulfilment flip decision
 * (js/measurement-shape.js's shouldFlipMeasurementShapeOnDeliver, mirrored
 * here in TS since Deno cannot import the browser-global js file — same
 * reasoning measurement-upgrade-gate.ts's own header gives) to demonstrate
 * the full scenario the gh-1411 closes-on asks for:
 *
 *   1. Contractor A's purchase is ALLOWED on a basic-shape claim.
 *   2. Admin delivers the detailed report -> claims.measurement_shape flips
 *      to 'full' (the ONLY writer, per D-317 / admin-measurements.html).
 *   3. Contractor B's purchase on the SAME claim is REFUSED (ALREADY_DETAILED)
 *      -- nothing left to buy.
 *
 * No Stripe calls, mocked or live -- this is pure-function composition only,
 * exactly like the sibling gate test file.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { evaluateMeasurementUpgradeGate } from "./measurement-upgrade-gate.ts";

// Mirrors js/measurement-shape.js's shouldFlipMeasurementShapeOnDeliver
// exactly (Deno cannot import the browser-global file -- see
// measurement-upgrade-gate.ts's own SHAPE GATE note for the same reasoning).
const UPGRADE_PRODUCT_CODE = "roof_upgrade_detailed";
function shouldFlipMeasurementShapeOnDeliver(
  order: { product_code?: string; claim_id?: string | null } | null | undefined,
  delivering: boolean,
): boolean {
  return !!delivering && !!order && order.product_code === UPGRADE_PRODUCT_CODE && !!order.claim_id;
}

Deno.test("second-contractor negative control: contractor A buys, admin delivers, contractor B is refused", () => {
  const claimId = "claim-e2e-1";
  // Shared mutable claim row -- the same claims row every contractor's gate
  // call reads, exactly as production has one claims row per project.
  const claim: { id: string; is_test: boolean; measurement_shape: string | null; hover_measurements: { squares: number } } = {
    id: claimId,
    is_test: false,
    measurement_shape: null, // pre-purchase: basic (NULL == basic-equivalent)
    hover_measurements: { squares: 42 },
  };
  const basicOrderStatus = "completed"; // roof_basic already delivered

  // ── Step 1: contractor A's purchase is allowed ──
  const contractorAVerdict = evaluateMeasurementUpgradeGate(claim, basicOrderStatus);
  assertEquals(contractorAVerdict.allow, true);
  if (contractorAVerdict.allow) {
    assertEquals(contractorAVerdict.amountCents, 2500); // 42 SQ < 50 -> $25 tier
  }

  // ── Step 2: admin delivers the detailed report for contractor A's order ──
  const contractorAOrder = { product_code: UPGRADE_PRODUCT_CODE, claim_id: claimId };
  const delivering = true; // admin entered detailed measurements this save
  const shouldFlip = shouldFlipMeasurementShapeOnDeliver(contractorAOrder, delivering);
  assertEquals(shouldFlip, true);
  if (shouldFlip) {
    claim.measurement_shape = "full"; // the write admin-measurements.html performs
  }

  // ── Step 3 (NEGATIVE CONTROL): contractor B's purchase on the SAME claim is refused ──
  const contractorBVerdict = evaluateMeasurementUpgradeGate(claim, basicOrderStatus);
  assertEquals(contractorBVerdict.allow, false);
  if (!contractorBVerdict.allow) {
    assertEquals(contractorBVerdict.code, "ALREADY_DETAILED");
    assertEquals(contractorBVerdict.status, 409);
  }
});

Deno.test("NEGATIVE CONTROL, isolated: delivering a roof_basic order (not the upgrade SKU) never flips the shape, so a later contractor is still allowed to buy", () => {
  const claim: { id: string; is_test: boolean; measurement_shape: string | null; hover_measurements: { squares: number } } = {
    id: "claim-e2e-2",
    is_test: false,
    measurement_shape: null,
    hover_measurements: { squares: 60 },
  };

  // Delivering the ORIGINAL roof_basic order must never flip the shape --
  // only the paid upgrade SKU may (see js/measurement-shape.js WRITER
  // DISCIPLINE and the shared unit test tests/measurement-shape-flip-on-deliver.mjs).
  const basicOrder = { product_code: "roof_basic", claim_id: claim.id };
  const shouldFlip = shouldFlipMeasurementShapeOnDeliver(basicOrder, true);
  assertEquals(shouldFlip, false);

  // So a contractor's upgrade purchase on this still-basic claim is allowed,
  // priced at the >=50 SQ tier.
  const verdict = evaluateMeasurementUpgradeGate(claim, "completed");
  assertEquals(verdict.allow, true);
  if (verdict.allow) {
    assertEquals(verdict.amountCents, 5500);
  }
});
