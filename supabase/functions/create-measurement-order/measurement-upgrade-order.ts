/**
 * [gh-1411, 2026-09-03] Recording half of the contractor detailed-measurement
 * upgrade purchase (D-317 cl. 4/5) — the counterpart to
 * create-payment-intent/measurement-upgrade-gate.ts, which mints the charge.
 *
 * WHY A SEPARATE PURE MODULE. Same reasoning as the sibling gate module: the
 * decision of WHAT ROW TO WRITE (and whether the Stripe amount we are about
 * to record is even a legitimate tier price) should be testable without a
 * database. create-measurement-order's index.ts calls this after it has
 * already verified the PaymentIntent succeeded via Stripe (verifyPayment) —
 * this module does not talk to Stripe or Supabase itself.
 *
 * SINGLE ROW FAMILY, NOT A THIRD REPRESENTATION. Per the R-097 notice
 * (Marty, #1411 cto-2026-09-02T13:45:25Z): two half-connected measurement
 * charge representations already existed in production before this build —
 * a `hover_orders` row with `homeowner_charge_amount=1500` and a null
 * PaymentIntent id, and a stray livemode PaymentIntent that never got a row.
 * This module's contract is that the PaymentIntent id is ALWAYS populated at
 * insert time (never left null to be reconciled later) and the row lives in
 * `hover_orders` — the same table every other measurement order already
 * uses — not a new table. It does not attempt to locate or edit any specific
 * pre-existing row; reconciling historical rows is a data operation this
 * Code-lane build cannot perform (no live DB access in this session) and is
 * called out as unresolved in this PR.
 *
 * REBATE / VENDOR-CREDIT BOOKKEEPING. `vendor_credit_expected_cents` records
 * the $15.00 D-317 cl. 4 says RoofScope owes back on the FIRST buyer's
 * upgrade — written, never netted against what the contractor was charged
 * (R-021: no refund logic in this build). Only the first buyer's row carries
 * it; see `isFirstBuyer`.
 *
 * STATUS. #1411's own issue body (filed before the CTO's tier/rails review)
 * named the initial status 'upgrade_requested'. This module deliberately
 * uses 'awaiting_fulfillment' instead — the SAME status the roof_basic paid
 * path already uses — because admin-measurements.html's status vocabulary
 * (badge CSS, the default filter tab, `canFulfil`, and the summary "oldest
 * awaiting" counter) is a closed set of four values the UI already
 * understands; a fifth, novel status would be invisible in the default
 * queue view and unopenable until admin-measurements.html were separately
 * taught about it. The row is, semantically, exactly what
 * 'awaiting_fulfillment' already means here: paid, and now waiting on a
 * human to enter the detailed values and deliver it — which is what
 * gh-1411's admin hook (see admin-measurements.html) does, flipping
 * `claims.measurement_shape` to 'full' at the same moment it flips this row
 * to 'completed', exactly as it already does for `roof_basic` orders. If a
 * distinct status is wanted after all, admin-measurements.html's status
 * vocabulary needs the matching UI update in the same change.
 */

export const UPGRADE_PRODUCT_CODE = "roof_upgrade_detailed";
export const UPGRADE_INITIAL_STATUS = "awaiting_fulfillment";
export const VENDOR_CREDIT_EXPECTED_CENTS = 1500;

/** The only two amounts (cents) a measurement_upgrade PaymentIntent may ever
 *  legitimately have succeeded for — mirrors create-payment-intent's tier
 *  pricing. Recomputing the SQ tier here would require re-reading the
 *  claim's squares a second time; checking against this fixed set instead
 *  is a cheaper, still-meaningful defense: a succeeded PI for any OTHER
 *  amount could not have come from this function's own PaymentIntent path. */
export const VALID_TIER_AMOUNTS_CENTS = [2500, 5500] as const;

export interface VerifiedUpgradePayment {
  amount: number;
  stripeChargeId: string | null;
}

export type UpgradeOrderDecision =
  | { ok: true; insertPayload: UpgradeOrderInsertPayload }
  | { ok: false; status: number; error: string };

export interface UpgradeOrderInsertPayload {
  claim_id: string;
  user_id: string;
  status: string;
  product_code: string;
  fulfillment_mode: string;
  requested_by_role: "contractor";
  requested_by_contractor_id: string;
  homeowner_stripe_payment_intent_id: string;
  homeowner_charge_amount: number;
  amount_charged: number;
  stripe_payment_id: string | null;
  vendor_credit_expected_cents: number | null;
  admin_notes: string | null;
}

/**
 * Build the hover_orders insert for a verified, succeeded measurement_upgrade
 * PaymentIntent. Refuses (rather than silently recording a mispriced row) if
 * the succeeded amount is not one of the known tier prices — this can only
 * happen if a PaymentIntent from a different, tampered-with call path was
 * replayed here, since create-payment-intent itself only ever mints these
 * two amounts for this type.
 *
 * `isFirstBuyer`: true when no other contractor has already bought this
 * claim's upgrade (checked by the caller via the same idempotency-by-PI-id
 * query every other product code already uses). Only the first buyer's row
 * carries the vendor-credit bookkeeping — D-317 cl. 4 is explicit that the
 * $15 credit is a one-time thing tied to the first purchase, not per-buyer.
 */
export function buildUpgradeOrderInsert(
  paid: VerifiedUpgradePayment,
  claimId: string,
  buyerUserId: string,
  contractorId: string,
  paymentIntentId: string,
  isFirstBuyer: boolean,
  note: string | null,
): UpgradeOrderDecision {
  if (!VALID_TIER_AMOUNTS_CENTS.includes(paid.amount as typeof VALID_TIER_AMOUNTS_CENTS[number])) {
    return {
      ok: false,
      status: 402,
      error: "Payment amount does not match a valid detailed-report tier price. Please contact support.",
    };
  }

  return {
    ok: true,
    insertPayload: {
      claim_id: claimId,
      user_id: buyerUserId,
      status: UPGRADE_INITIAL_STATUS,
      product_code: UPGRADE_PRODUCT_CODE,
      fulfillment_mode: "manual",
      requested_by_role: "contractor",
      requested_by_contractor_id: contractorId,
      // Populated at insert time, always — never left null for a later
      // reconciliation pass. See the module doc above.
      homeowner_stripe_payment_intent_id: paymentIntentId,
      homeowner_charge_amount: paid.amount,
      amount_charged: paid.amount / 100,
      stripe_payment_id: paid.stripeChargeId,
      vendor_credit_expected_cents: isFirstBuyer ? VENDOR_CREDIT_EXPECTED_CENTS : null,
      admin_notes: note,
    },
  };
}
