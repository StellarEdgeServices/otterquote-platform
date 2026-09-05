/**
 * [gh-1411, 2026-09-03] Eligibility + pricing gate for the contractor
 * detailed-measurement upgrade purchase (D-317 cl. 4/5).
 *
 * WHY A SEPARATE PURE MODULE. create-payment-intent's handler does network
 * I/O (Supabase reads, Stripe calls) end to end, which makes the actual
 * money decision hard to test in isolation. Every branch that decides
 * WHETHER and HOW MUCH to charge belongs here instead, so it can be
 * unit-tested without a database or Stripe — the same reasoning
 * live-charge-guard.ts documents for itself, and this module composes that
 * guard directly rather than re-deciding the test-claim question itself.
 *
 * PRICING (D-317 cl. 4, Dustin verbatim on #1339): "$25 under 50 SQ / $55
 * over 50 SQ", tier read from the claim's BASIC report squares — never a
 * flat catalog price (a flat SKU price cannot express a tiered amount; see
 * #1411's issue body). 50.0 SQ itself is the "over" boundary: a claim at
 * exactly 50.0 squares is priced at $55, not $25 — this is the "49.9 / 50.0"
 * split named in the R-097 notice's test-case list.
 *
 * REBATE BOOKKEEPING. RoofScope applies the first $15 it was already paid
 * for the basic report to the cost of the full report (Dustin, #1339). This
 * module reports that fixed $15.00 (`VENDOR_CREDIT_EXPECTED_CENTS`) as an
 * amount OtterQuote expects the vendor to credit — it is bookkeeping, not a
 * charge adjustment: the contractor still pays the full $25/$55 tier price,
 * and this module never nets the credit against it (Marty, #1411
 * cto-2026-09-02T13:45:25Z: "does not net it against the charge"). Whether
 * the credit actually arrives is a manual reconciliation item on the admin
 * fulfilment surface (hover_orders.vendor_credit_expected_cents), never a
 * refund path — refunds stay Tier C (R-021); this build issues none.
 *
 * SHAPE GATE (#1410). `claims.measurement_shape` may not exist in the live
 * schema yet — js/measurement-shape.js documents the migration as drafted
 * but pending D-182 approval, and mandates NULL/absent/unexpected values all
 * resolve to 'basic'. This module mirrors that exact contract in TypeScript
 * (Deno edge functions cannot import the browser-global js/measurement-shape.js
 * — see that file's own "do not import cross-world" note) rather than
 * re-deriving it: a claim already flagged 'full' refuses to mint a second
 * PaymentIntent (the "already-detailed no-mint" test case) and everything
 * else — including the column not existing at all — is treated as 'basic'
 * and the purchase is allowed to proceed to its other checks.
 *
 * FAIL CLOSED on the money-relevant unknowns: an unreadable claim, a missing
 * basic-report fulfillment, or a missing/invalid squares reading all refuse
 * rather than guess a price or an eligibility.
 */

import {
  evaluateLiveChargeGuard,
  type GuardClaimRow,
} from "./live-charge-guard.ts";

/** The vendor credit D-317 cl. 4 says RoofScope applies to the first buyer's
 *  full-scope cost, in cents. Recorded, never netted against the charge. */
export const VENDOR_CREDIT_EXPECTED_CENTS = 1500;

/** SQ tier boundary: a claim AT or ABOVE this many squares is priced $55;
 *  strictly below it is priced $25. */
export const SQ_TIER_BOUNDARY = 50;

export const PRICE_UNDER_TIER_CENTS = 2500;
export const PRICE_AT_OR_OVER_TIER_CENTS = 5500;

/** Stripe-facing description. D-312/#1414 scrubbed every vendor name from
 *  customer-facing strings — this must never be a vendor's name. */
export const UPGRADE_CHARGE_DESCRIPTION = "Detailed roof measurement report";

/** hover_orders.product_code for this SKU. Not catalog-backed (a flat
 *  catalog price can't express the SQ tier), so it is not required to exist
 *  in platform_settings.measurement_products — see the module doc above. */
export const UPGRADE_PRODUCT_CODE = "roof_upgrade_detailed";

export interface UpgradeClaimRow extends GuardClaimRow {
  measurement_shape?: string | null;
  hover_measurements?: { squares?: number | null } | null;
}

export type UpgradeGateVerdict =
  | { allow: true; amountCents: number; squares: number }
  | { allow: false; status: number; code: string; error: string };

/** #1410 tolerant shape read: NULL, absent, the column not existing at all,
 *  or any value other than the literal string 'full' all mean 'basic'. */
function resolveShape(claim: UpgradeClaimRow | null | undefined): "basic" | "full" {
  return claim && claim.measurement_shape === "full" ? "full" : "basic";
}

/** Squares -> tier price. Exported standalone so the 49.9 / 50.0 boundary is
 *  directly testable without constructing a whole claim/order fixture. */
export function priceForSquares(squares: number): number {
  return squares >= SQ_TIER_BOUNDARY ? PRICE_AT_OR_OVER_TIER_CENTS : PRICE_UNDER_TIER_CENTS;
}

/**
 * Decide whether a detailed-measurement upgrade PaymentIntent may be minted
 * for this claim, and at what price.
 *
 * @param claim            The claims row (select('*') — see the shape-gate
 *                          note above for why this must not be an explicit
 *                          column list yet).
 * @param basicOrderStatus The status of this claim's `roof_basic` hover_orders
 *                          row, or null if none exists. Only 'completed'
 *                          (admin-delivered — see admin-measurements.html)
 *                          counts as fulfilled.
 */
export function evaluateMeasurementUpgradeGate(
  claim: UpgradeClaimRow | null | undefined,
  basicOrderStatus: string | null | undefined,
): UpgradeGateVerdict {
  // ── #1467 GATE, reused verbatim (never re-implemented) ──
  const chargeGuard = evaluateLiveChargeGuard(claim);
  if (!chargeGuard.allow) {
    return {
      allow: false,
      status: 422,
      code: "TEST_CLAIM_CHARGE_REFUSED",
      error: chargeGuard.reason === "claim_unreadable"
        ? "We could not verify this claim. Nothing has been charged."
        : "This claim is a test claim and is not authorized for a live charge.",
    };
  }

  // ── #1410 shape gate: already detailed -> nothing to buy ──
  if (resolveShape(claim) === "full") {
    return {
      allow: false,
      status: 409,
      code: "ALREADY_DETAILED",
      error: "This claim's measurements are already the detailed report — there is nothing to purchase.",
    };
  }

  // ── The basic report must be bought and delivered first ──
  if (basicOrderStatus !== "completed") {
    return {
      allow: false,
      status: 400,
      code: "BASIC_REPORT_NOT_READY",
      error: "A basic measurement report must be purchased and delivered before the detailed upgrade can be bought.",
    };
  }

  // ── Price from the basic report's measured squares — never a flat price ──
  const squares = claim?.hover_measurements?.squares;
  if (typeof squares !== "number" || !Number.isFinite(squares) || squares <= 0) {
    return {
      allow: false,
      status: 400,
      code: "SQUARES_UNKNOWN",
      error: "Cannot price the upgrade: no measured squares are on file for this claim.",
    };
  }

  return { allow: true, amountCents: priceForSquares(squares), squares };
}
