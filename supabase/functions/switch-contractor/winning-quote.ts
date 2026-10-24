// gh-3052 (fix for review B1): retry-safe lookup of the quote being switched away.
//
// Step 6 of index.ts retires the quote (status 'declined' + bid_status 'superseded')
// BEFORE step 7 resets the claim. If step 7 then fails (500), the claim is still
// contract_signed/awarded with selected_contractor_id set, but the quote is no longer
// 'selected'. The homeowner's retry must still find that quote so step 8 refunds the
// platform fee. Stripe-side double refund is prevented by the payment_status === "succeeded"
// gate (step 8 flips it to "refunded" after a successful refund) and Stripe itself refuses
// a second full refund of a charge.

/** PostgREST .or() filter: a live winning quote OR the exact shape this flow retires one into. */
export const WINNING_QUOTE_OR_FILTER =
  "status.in.(selected,awarded)," +
  "and(status.eq.declined,bid_status.eq.superseded,cancellation_reason.eq.homeowner_switched_contractor)";

export interface WinningQuoteRow {
  status?: string | null;
  bid_status?: string | null;
  cancellation_reason?: string | null;
  [k: string]: unknown;
}

/** True when the row is a quote this flow already retired (partial-failure retry). */
export function isRetiredBySwitch(q: WinningQuoteRow): boolean {
  return q.status === "declined" && q.bid_status === "superseded" &&
    q.cancellation_reason === "homeowner_switched_contractor";
}

/**
 * Rows arrive newest-first, already scoped to the claim and its selected_contractor_id.
 * A live selected/awarded quote always wins over a previously retired one.
 */
export function pickWinningQuote<T extends WinningQuoteRow>(rows: T[] | null | undefined): T | null {
  if (!rows || rows.length === 0) return null;
  return rows.find((r) => !isRetiredBySwitch(r)) ?? rows[0];
}

/** Step 8 gate: refund only a charge that still shows succeeded (never one already marked refunded). */
export function shouldIssueRefund(
  q: { payment_intent_id?: string | null; payment_status?: string | null } | null,
  hasStripeKey: boolean,
): boolean {
  return !!(q?.payment_intent_id && q?.payment_status === "succeeded" && hasStripeKey);
}
