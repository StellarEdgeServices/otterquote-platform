/**
 * [gh-1411, 2026-09-26] Second-contractor negative control, end to end at the
 * code level.
 *
 * The gate module's own test suite (measurement-upgrade-gate.test.ts) locks
 * the "already-detailed no-mint" case in isolation. This file composes that
 * same pure gate with the REAL admin-fulfilment flip decision from
 * js/measurement-shape.js's shouldFlipMeasurementShapeOnDeliver() to
 * demonstrate the full scenario the gh-1411 closes-on asks for:
 *
 *   1. Contractor A's purchase is ALLOWED on a basic-shape claim.
 *   2. Admin delivers the detailed report -> claims.measurement_shape flips
 *      to 'full' (the ONLY writer, per D-317 / admin-measurements.html).
 *   3. Contractor B's purchase on the SAME claim is REFUSED (ALREADY_DETAILED)
 *      -- nothing left to buy.
 *
 * REVIEW FIX (finding A, PR #2236 comment 5850578681): this file previously
 * hand-copied shouldFlipMeasurementShapeOnDeliver as a TS mirror. The
 * reviewer's negative control (temporarily making the real function
 * `return true;`) proved the mirror diverges silently -- the mirror stayed
 * green while the real production function would have flipped on ANY order.
 * Deno cannot `import` a browser-global file (js/measurement-shape.js sets
 * `window.MeasurementShape`, not an ES export), so instead this file loads
 * the real source as TEXT via Deno.readTextFileSync and evaluates it against
 * a minimal `window` stub -- the same "read the sibling source as text"
 * pattern gh-1319's exhibit-a-shapes.test.ts already uses in this repo for
 * an otherwise single-file, untestable surface (see
 * .github/workflows/e2e-tests.yml's Edge Function unit tests step comment).
 * This makes the test exercise the ACTUAL function that ships to
 * admin-measurements.html, not a copy that can drift from it.
 *
 * No Stripe calls, mocked or live -- this is pure-function composition only,
 * exactly like the sibling gate test file.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { evaluateMeasurementUpgradeGate } from "./measurement-upgrade-gate.ts";

// Load the REAL js/measurement-shape.js source (repo root, three levels up
// from supabase/functions/create-payment-intent/) and evaluate it against a
// plain object standing in for `window`, exactly as the browser does --
// admin-measurements.html includes this file with a <script> tag, which
// runs it in global/window scope, not as a module.
const MEASUREMENT_SHAPE_JS_PATH = new URL("../../../js/measurement-shape.js", import.meta.url);
const measurementShapeSource = Deno.readTextFileSync(MEASUREMENT_SHAPE_JS_PATH);

interface MeasurementShapeApi {
  resolveClaimMeasurementShape(claim: unknown): "basic" | "full";
  claimHasFullMeasurements(claim: unknown): boolean;
  UPGRADE_PRODUCT_CODE: string;
  shouldFlipMeasurementShapeOnDeliver(
    order: { product_code?: string; claim_id?: string | null } | null | undefined,
    delivering: boolean,
  ): boolean;
}

function loadRealMeasurementShapeApi(): MeasurementShapeApi {
  // `window` is the only global the source file touches (see its own
  // `(typeof window !== 'undefined' ? window : globalThis).MeasurementShape = {...}`
  // tail) -- passing a plain object as `window` and reading it back after
  // evaluation captures exactly what the browser would attach.
  const evaluate = new Function("window", `${measurementShapeSource}\nreturn window;`);
  const windowStub: { MeasurementShape?: MeasurementShapeApi } = {};
  const result = evaluate(windowStub) as { MeasurementShape?: MeasurementShapeApi };
  if (!result.MeasurementShape) {
    throw new Error("js/measurement-shape.js did not attach window.MeasurementShape -- source file contract changed?");
  }
  return result.MeasurementShape;
}

const { shouldFlipMeasurementShapeOnDeliver, UPGRADE_PRODUCT_CODE } = loadRealMeasurementShapeApi();

Deno.test("sanity: the loaded function is the real one, not a stand-in (constant matches production)", () => {
  assertEquals(UPGRADE_PRODUCT_CODE, "roof_upgrade_detailed");
  assertStringIncludes(measurementShapeSource, "function shouldFlipMeasurementShapeOnDeliver(order, delivering)");
});

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

  // ── Step 2: admin delivers the detailed report for contractor A's order,
  //    using the REAL shouldFlipMeasurementShapeOnDeliver loaded above ──
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
  // Uses the REAL function loaded above, not a hand copy.
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
