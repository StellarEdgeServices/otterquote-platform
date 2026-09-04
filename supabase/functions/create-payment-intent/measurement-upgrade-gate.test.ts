import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  evaluateMeasurementUpgradeGate,
  PRICE_AT_OR_OVER_TIER_CENTS,
  PRICE_UNDER_TIER_CENTS,
  priceForSquares,
  SQ_TIER_BOUNDARY,
  UPGRADE_CHARGE_DESCRIPTION,
  VENDOR_CREDIT_EXPECTED_CENTS,
} from "./measurement-upgrade-gate.ts";

const REAL_CLAIM = { id: "c1", is_test: false };

Deno.test("49.9 / 50.0 SQ tier boundary: strictly under 50 is $25, at or over is $55", () => {
  assertEquals(priceForSquares(49.9), PRICE_UNDER_TIER_CENTS);
  assertEquals(priceForSquares(49.9), 2500);
  assertEquals(priceForSquares(50.0), PRICE_AT_OR_OVER_TIER_CENTS);
  assertEquals(priceForSquares(50.0), 5500);
  assertEquals(priceForSquares(SQ_TIER_BOUNDARY), PRICE_AT_OR_OVER_TIER_CENTS);
});

Deno.test("full gate: a real claim, basic report delivered, squares on file -> allowed at the right tier", () => {
  const verdict = evaluateMeasurementUpgradeGate(
    { ...REAL_CLAIM, hover_measurements: { squares: 32.4 } },
    "completed",
  );
  assertEquals(verdict, { allow: true, amountCents: 2500, squares: 32.4 });

  const verdictOver = evaluateMeasurementUpgradeGate(
    { ...REAL_CLAIM, hover_measurements: { squares: 61 } },
    "completed",
  );
  assertEquals(verdictOver, { allow: true, amountCents: 5500, squares: 61 });
});

Deno.test("refuse-on-test-claim: an unauthorized TEST claim is refused before any price is computed (#1467 reused)", () => {
  const verdict = evaluateMeasurementUpgradeGate(
    { id: "c2", is_test: true, live_charge_authorized_at: null, hover_measurements: { squares: 30 } },
    "completed",
  );
  assertEquals(verdict.allow, false);
  if (!verdict.allow) {
    assertEquals(verdict.status, 422);
    assertEquals(verdict.code, "TEST_CLAIM_CHARGE_REFUSED");
  }
});

Deno.test("a TEST claim WITH the #1467 marker is still gated by shape/basic-report/squares, not blocked by test status", () => {
  const verdict = evaluateMeasurementUpgradeGate(
    {
      id: "c3",
      is_test: true,
      live_charge_authorized_at: "2026-09-02T03:00:00+00:00",
      hover_measurements: { squares: 55 },
    },
    "completed",
  );
  assertEquals(verdict, { allow: true, amountCents: 5500, squares: 55 });
});

Deno.test("already-detailed no-mint: measurement_shape === 'full' refuses regardless of everything else", () => {
  const verdict = evaluateMeasurementUpgradeGate(
    { ...REAL_CLAIM, measurement_shape: "full", hover_measurements: { squares: 30 } },
    "completed",
  );
  assertEquals(verdict.allow, false);
  if (!verdict.allow) {
    assertEquals(verdict.status, 409);
    assertEquals(verdict.code, "ALREADY_DETAILED");
  }
});

Deno.test("#1410 tolerance: measurement_shape absent, null, or the column missing entirely all resolve to 'basic' (purchase proceeds)", () => {
  const absent = evaluateMeasurementUpgradeGate({ ...REAL_CLAIM, hover_measurements: { squares: 10 } }, "completed");
  assertEquals(absent.allow, true);

  const nullShape = evaluateMeasurementUpgradeGate(
    { ...REAL_CLAIM, measurement_shape: null, hover_measurements: { squares: 10 } },
    "completed",
  );
  assertEquals(nullShape.allow, true);

  const unexpectedShape = evaluateMeasurementUpgradeGate(
    { ...REAL_CLAIM, measurement_shape: "some_future_value", hover_measurements: { squares: 10 } },
    "completed",
  );
  assertEquals(unexpectedShape.allow, true);
});

Deno.test("no basic report delivered yet refuses -- 'awaiting_fulfillment' and no row are both not 'completed'", () => {
  const noOrder = evaluateMeasurementUpgradeGate({ ...REAL_CLAIM, hover_measurements: { squares: 30 } }, null);
  assertEquals(noOrder.allow, false);
  if (!noOrder.allow) assertEquals(noOrder.code, "BASIC_REPORT_NOT_READY");

  const notYetDelivered = evaluateMeasurementUpgradeGate(
    { ...REAL_CLAIM, hover_measurements: { squares: 30 } },
    "awaiting_fulfillment",
  );
  assertEquals(notYetDelivered.allow, false);
  if (!notYetDelivered.allow) assertEquals(notYetDelivered.code, "BASIC_REPORT_NOT_READY");
});

Deno.test("no squares on file refuses rather than guessing a price", () => {
  const missing = evaluateMeasurementUpgradeGate({ ...REAL_CLAIM, hover_measurements: {} }, "completed");
  assertEquals(missing.allow, false);
  if (!missing.allow) assertEquals(missing.code, "SQUARES_UNKNOWN");

  const zero = evaluateMeasurementUpgradeGate(
    { ...REAL_CLAIM, hover_measurements: { squares: 0 } },
    "completed",
  );
  assertEquals(zero.allow, false);

  const negative = evaluateMeasurementUpgradeGate(
    { ...REAL_CLAIM, hover_measurements: { squares: -4 } },
    "completed",
  );
  assertEquals(negative.allow, false);

  const nonNumeric = evaluateMeasurementUpgradeGate(
    { ...REAL_CLAIM, hover_measurements: { squares: "41" as unknown as number } },
    "completed",
  );
  assertEquals(nonNumeric.allow, false);
});

Deno.test("FAIL CLOSED: an unreadable claim refuses before the shape/basic-report/price checks ever run", () => {
  const verdict = evaluateMeasurementUpgradeGate(null, "completed");
  assertEquals(verdict.allow, false);
  if (!verdict.allow) assertEquals(verdict.code, "TEST_CLAIM_CHARGE_REFUSED");
});

Deno.test("customer-facing description names no vendor (D-312 / #1414) and is exact", () => {
  assertEquals(UPGRADE_CHARGE_DESCRIPTION, "Detailed roof measurement report");
  assertEquals(/hover/i.test(UPGRADE_CHARGE_DESCRIPTION), false);
  assertEquals(/roofscope/i.test(UPGRADE_CHARGE_DESCRIPTION), false);
});

Deno.test("vendor credit bookkeeping constant matches D-317 cl. 4 ($15.00) and is a fixed record, not computed from the charge", () => {
  assertEquals(VENDOR_CREDIT_EXPECTED_CENTS, 1500);
});
