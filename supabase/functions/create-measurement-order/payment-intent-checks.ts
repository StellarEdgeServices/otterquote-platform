/**
 * [gh-2107 / D-330] The post-fetch checks on a Stripe PaymentIntent, as pure functions, plus the USD guard.
 *
 * Ben's step 2 on #2078 (5806312169): "create-measurement-order rejects any PaymentIntent whose currency !== 'usd'."
 * REVIEW 5805884795 (N1) on #2107 found the gap: create-payment-intent does not pin `currency` for hover_measurement (it only
 * checks it is a string and passes it to Stripe), and this function checked a succeeded PaymentIntent's AMOUNT but never its
 * CURRENCY, so a hand-crafted amount=1500, currency=jpy (about $10) could be accepted as a paid $15 report, and reported to Meta
 * as 15 USD. Every price in this function is in US cents; a PaymentIntent in another currency has no defined value here.
 *
 * WHY A MODULE. verifyPayment and verifyUpgradePayment live inside index.ts (which starts the server on import), so their checks
 * could not be tested with PaymentIntent objects. The checks moved here VERBATIM, in the same order, with the same messages, and
 * the ONLY addition is the currency check, placed right after the status check and before the amount check. The differential
 * test in payment-intent-checks.test.ts compares this module with a literal copy of main's checks so nothing else changed.
 *
 * The caller still fetches the PaymentIntent from Stripe itself (never from the request) and passes the object here.
 */

export const PI_TYPE = "measurement_order";
/** Legacy value still emitted by the older frontend path (create-payment-intent's hover_measurement charge). */
export const PI_TYPE_LEGACY = "hover_measurement";

/** Fixed text for the client: it names no amount, currency or PaymentIntent. */
export const CURRENCY_REJECTION_MESSAGE = "This payment could not be accepted because it was not made in US dollars. Nothing further has been charged. Please contact support.";

export type PaymentCheckResult =
  | { ok: true; amount: number; stripeChargeId: string | null }
  | { ok: false; status: number; error: string };

// deno-lint-ignore no-explicit-any
type PaymentIntentLike = any;

type Log = (message: string, detail?: unknown) => void;
const defaultLog: Log = (m, d) => (d === undefined ? console.error(m) : console.error(m, d));

/** Stripe reports a PaymentIntent's currency as a lowercase ISO code. Anything but exactly "usd" (absent included) is refused. */
function usdOnly(pi: PaymentIntentLike, log: Log): PaymentCheckResult | null {
  if (pi.currency !== "usd") {
    // The code itself is a short ISO token from Stripe; it is logged for the operator, never returned to the client.
    log("[create-measurement-order] PI currency is not usd:", { currency: typeof pi.currency === "string" ? pi.currency.slice(0, 8) : typeof pi.currency, pi: pi.id });
    return { ok: false, status: 402, error: CURRENCY_REJECTION_MESSAGE };
  }
  return null;
}

/** verifyPayment's checks: the buyer really paid, in USD, the catalog price, for this claim, as a measurement charge. */
export function checkMeasurementPaymentIntent(
  pi: PaymentIntentLike,
  ctx: { expectedAmount: number; claimId: string | null; log?: Log },
): PaymentCheckResult {
  const log = ctx.log ?? defaultLog;
  if (pi.status !== "succeeded") {
    return {
      ok: false,
      status: 402,
      error: `Payment must complete before we can order your report. Current payment status: ${pi.status}.`,
    };
  }
  const notUsd = usdOnly(pi, log);
  if (notUsd) return notUsd;
  if (pi.amount !== ctx.expectedAmount) {
    log("[create-measurement-order] PI amount mismatch:", { got: pi.amount, expected: ctx.expectedAmount, pi: pi.id });
    return { ok: false, status: 402, error: "Payment amount does not match the report price. Please contact support." };
  }
  if (ctx.claimId && pi.metadata?.claim_id && pi.metadata.claim_id !== ctx.claimId) {
    log("[create-measurement-order] PI claim mismatch:", { pi_claim: pi.metadata.claim_id, supplied: ctx.claimId });
    return { ok: false, status: 402, error: "Payment does not belong to this project. Please contact support." };
  }
  if (pi.metadata?.type && pi.metadata.type !== PI_TYPE && pi.metadata.type !== PI_TYPE_LEGACY) {
    log("[create-measurement-order] PI type mismatch:", { pi_type: pi.metadata.type });
    return { ok: false, status: 402, error: "Payment is not a measurement charge. Please contact support." };
  }
  return { ok: true, amount: pi.amount, stripeChargeId: pi.latest_charge ?? null };
}

/** verifyUpgradePayment's checks: settled, in USD, for the right claim, as a measurement_upgrade charge (the tier amount is checked by the caller). */
export function checkUpgradePaymentIntent(
  pi: PaymentIntentLike,
  ctx: { claimId: string; log?: Log },
): PaymentCheckResult {
  const log = ctx.log ?? defaultLog;
  if (pi.status !== "succeeded") {
    return {
      ok: false,
      status: 402,
      error: `Payment must complete before we can order your report. Current payment status: ${pi.status}.`,
    };
  }
  const notUsd = usdOnly(pi, log);
  if (notUsd) return notUsd;
  if (pi.metadata?.claim_id && pi.metadata.claim_id !== ctx.claimId) {
    log("[create-measurement-order] upgrade PI claim mismatch:", { pi_claim: pi.metadata.claim_id, supplied: ctx.claimId });
    return { ok: false, status: 402, error: "Payment does not belong to this project. Please contact support." };
  }
  if (pi.metadata?.type !== "measurement_upgrade") {
    log("[create-measurement-order] upgrade PI type mismatch:", { pi_type: pi.metadata?.type });
    return { ok: false, status: 402, error: "Payment is not a measurement-upgrade charge. Please contact support." };
  }
  return { ok: true, amount: pi.amount, stripeChargeId: pi.latest_charge ?? null };
}
