import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildPriorUpgradeLookupQuery,
  evaluateMeasurementUpgradeGate,
  PRICE_AT_OR_OVER_TIER_CENTS,
  PRICE_UNDER_TIER_CENTS,
  priceForSquares,
  resolveContractorAlreadyPurchased,
  SQ_TIER_BOUNDARY,
  UPGRADE_CHARGE_DESCRIPTION,
  UPGRADE_PRODUCT_CODE,
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

Deno.test("already-purchased no-mint: measurement_shape === 'full' AND this contractor already bought it refuses", () => {
  const verdict = evaluateMeasurementUpgradeGate(
    { ...REAL_CLAIM, measurement_shape: "full", hover_measurements: { squares: 30 } },
    "completed",
    true, // contractorAlreadyPurchased
  );
  assertEquals(verdict.allow, false);
  if (!verdict.allow) {
    assertEquals(verdict.status, 409);
    assertEquals(verdict.code, "ALREADY_PURCHASED");
  }
});

// [gh-1411 D-317 cl. 4, #1411 comment 5856964558 "APPROVE TO ALL"] A claim
// already flipped to Shape B does NOT wave a DIFFERENT (later) contractor
// through free -- they pay the same tier price. Only a repeat purchase by
// the SAME contractor (contractorAlreadyPurchased=true, tested above) is
// refused. This is the behaviour PR #2236 deliberately left NAMED-BLOCKED
// (comment 5850724836) pending this Dustin ruling.
Deno.test("later-contractor-pays (D-317 cl. 4): measurement_shape === 'full' but THIS contractor has not purchased -> allowed, charged full tier price", () => {
  const verdictUnder = evaluateMeasurementUpgradeGate(
    { ...REAL_CLAIM, measurement_shape: "full", hover_measurements: { squares: 42 } },
    "completed",
    false, // this contractor has not purchased it yet
  );
  assertEquals(verdictUnder, { allow: true, amountCents: 2500, squares: 42 });

  const verdictOver = evaluateMeasurementUpgradeGate(
    { ...REAL_CLAIM, measurement_shape: "full", hover_measurements: { squares: 60 } },
    "completed",
    false,
  );
  assertEquals(verdictOver, { allow: true, amountCents: 5500, squares: 60 });
});

// [REVIEW: FAIL 5869709815, nit] The dedupe must apply on ANY shape, not
// only 'full' -- a contractor could otherwise double-buy the upgrade while
// the claim is still Shape A (paid by them, not yet admin-delivered).
Deno.test("already-purchased dedupe applies even on shape 'basic' (paid, not yet delivered)", () => {
  const verdict = evaluateMeasurementUpgradeGate(
    { ...REAL_CLAIM, measurement_shape: "basic", hover_measurements: { squares: 30 } },
    "completed",
    true, // contractorAlreadyPurchased
  );
  assertEquals(verdict.allow, false);
  if (!verdict.allow) {
    assertEquals(verdict.status, 409);
    assertEquals(verdict.code, "ALREADY_PURCHASED");
  }
});

// [REVIEW: FAIL 5869709815, must-fix 1] The per-contractor lookup
// (index.ts) must fail CLOSED on a query error -- never silently read a
// failed read as "no prior purchase found," which would let an
// already-paid contractor mint a second PaymentIntent.
Deno.test("resolveContractorAlreadyPurchased: a query error refuses (fails closed), never defaults to not-purchased", () => {
  const check = resolveContractorAlreadyPurchased({ data: null, error: { message: "connection reset", code: "08006" } });
  assertEquals(check.ok, false);
  if (!check.ok) {
    assertEquals(check.status, 503);
    assertEquals(check.code, "UPGRADE_STATUS_LOOKUP_FAILED");
  }
});

Deno.test("resolveContractorAlreadyPurchased: no error, a row found -> alreadyPurchased true", () => {
  const check = resolveContractorAlreadyPurchased({ data: { id: "order-1" }, error: null });
  assertEquals(check, { ok: true, alreadyPurchased: true });
});

Deno.test("resolveContractorAlreadyPurchased: no error, no row (null/undefined data) -> alreadyPurchased false", () => {
  assertEquals(resolveContractorAlreadyPurchased({ data: null, error: null }), { ok: true, alreadyPurchased: false });
  assertEquals(resolveContractorAlreadyPurchased({ data: undefined, error: undefined }), { ok: true, alreadyPurchased: false });
});

// [REVIEW: FAIL 5869709815, nit] Pins the exact table/column/constant
// wiring the dedupe lookup must use, so a future edit that renames or drops
// a filter (e.g. `requested_by_contractor_id`, or the UPGRADE_PRODUCT_CODE
// scope) is caught without a database or a chainable Supabase-client mock.
const CLAIM_ID = "66666666-7777-4888-8999-000000000000";
const CONTRACTOR = "cccccccc-1111-4222-8333-444444444444";
const OTHER_CONTRACTOR = "cccccccc-9999-4222-8333-444444444444";
const BUYER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_BUYER = "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee";

Deno.test("buildPriorUpgradeLookupQuery: correct table, select, (claim_id, product_code) filters, and the contractor-or-null-id-buyer OR filter", () => {
  const query = buildPriorUpgradeLookupQuery({ claimId: "claim-1", contractorId: CONTRACTOR, buyerUserId: BUYER });
  assertEquals(query.table, "hover_orders");
  assertEquals(query.select, "id");
  assertEquals(query.eq, [
    ["claim_id", "claim-1"],
    ["product_code", UPGRADE_PRODUCT_CODE],
  ]);
  // The product-code filter must be the constant, not a copy-pasted literal
  // that could drift from it.
  assertEquals(query.eq[1][1], "roof_upgrade_detailed");
  assertEquals(
    query.or,
    `requested_by_contractor_id.eq.${CONTRACTOR},and(requested_by_contractor_id.is.null,user_id.eq.${BUYER})`,
  );
});

// [gh-3459] A tiny evaluator for the filters the query object names, so the test can ask the real question: which stored orders does the gate see?
type Row = { claim_id: string; product_code: string; requested_by_contractor_id: string | null; user_id: string };
function gateSees(q: ReturnType<typeof buildPriorUpgradeLookupQuery>, row: Row): boolean {
  for (const [col, val] of q.eq) if ((row as unknown as Record<string, unknown>)[col] !== val) return false;
  // `or` is optional here ON PURPOSE: before gh-3459 the query had no `or`; it matched on requested_by_contractor_id as a third `eq` pair.
  const or = (q as { or?: string }).or;
  if (or === undefined) return true;
  return or.split(/,(?![^()]*\))/).some((branch) => {
    const eq = branch.match(/^requested_by_contractor_id\.eq\.(.+)$/);
    if (eq) return row.requested_by_contractor_id === eq[1];
    const nul = branch.match(/^and\(requested_by_contractor_id\.is\.null,user_id\.eq\.(.+)\)$/);
    return !!nul && row.requested_by_contractor_id === null && row.user_id === nul[1];
  });
}
const baseRow: Row = { claim_id: CLAIM_ID, product_code: UPGRADE_PRODUCT_CODE, requested_by_contractor_id: null, user_id: BUYER };
const lookup = (over: Partial<{ contractorId: string; buyerUserId: string }> = {}) =>
  buildPriorUpgradeLookupQuery({ claimId: CLAIM_ID, contractorId: CONTRACTOR, buyerUserId: BUYER, ...over });

Deno.test("gh-3459: a PAID upgrade recorded with a NULL contractor id is seen by the gate for the same buyer, so a second PaymentIntent is refused (fails before the fix)", () => {
  assertEquals(gateSees(lookup(), baseRow), true);
  const check = resolveContractorAlreadyPurchased({ data: gateSees(lookup(), baseRow) ? { id: "order-1" } : null, error: null });
  assertEquals(check, { ok: true, alreadyPurchased: true });
});

Deno.test("gh-3459: the ordinary case still works -- an order with this contractor's id is seen", () => {
  assertEquals(gateSees(lookup(), { ...baseRow, requested_by_contractor_id: CONTRACTOR, user_id: OTHER_BUYER }), true);
});

Deno.test("gh-3459: NEGATIVE CONTROLS -- the gate does not over-block", () => {
  // a null-id order bought by a DIFFERENT user is not this buyer's purchase
  assertEquals(gateSees(lookup(), { ...baseRow, user_id: OTHER_BUYER }), false);
  // another contractor's order (real id) bought by the same user is not matched by the null-id branch
  assertEquals(gateSees(lookup(), { ...baseRow, requested_by_contractor_id: OTHER_CONTRACTOR }), false);
  // a different claim, a different product
  assertEquals(gateSees(lookup(), { ...baseRow, claim_id: "other-claim" }), false);
  assertEquals(gateSees(lookup(), { ...baseRow, product_code: "roof_basic" }), false);
});

Deno.test("gh-3459: a non-uuid id is refused before it reaches a filter string (no filter injection)", () => {
  for (const bad of ["x),user_id.neq.0", "", "contractor-1"]) {
    assertThrows(() => lookup({ contractorId: bad }));
    assertThrows(() => lookup({ buyerUserId: bad }));
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
