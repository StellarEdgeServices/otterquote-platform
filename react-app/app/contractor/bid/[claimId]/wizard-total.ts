/**
 * gh-3495 (D-267): a multi-trade (wizard) bid's total is the SUM of its trades,
 * in whole cents. The Grand Total the contractor sees, quotes.total_price, the
 * fee shown and accepted, quotes.fee_amount and the charge
 * (docusign-webhook: total_price x pct) must all be derived from this one number.
 *
 * Pure and ASCII-only. No fee rate and no displayed wording lives here.
 */

/** Parse one typed price to whole cents; blank, negative or non-numeric -> 0. */
export function priceToCents(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

/** Round a dollar amount to whole cents (fixes typed fractions such as 9734.095). */
export function roundDollars(n: number): number {
  return priceToCents(n) / 100;
}

/**
 * Per-trade prices (dollars, whole cents) for the trades on the bid, in queue
 * order. Trades with no price entered are omitted.
 */
export function wizardTradePrices(
  queue: readonly string[],
  prices: Record<string, unknown>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const trade of queue) {
    const cents = priceToCents(prices[trade]);
    if (cents > 0) out[trade] = cents / 100;
  }
  return out;
}

/** Sum of every priced trade on the bid, whole cents, returned in dollars. */
export function wizardGrandTotal(
  queue: readonly string[],
  prices: Record<string, unknown>,
): number {
  let cents = 0;
  for (const trade of queue) cents += priceToCents(prices[trade]);
  return cents / 100;
}

/**
 * The one bid amount used for the fee shown, the fee accepted, total_price and
 * fee_amount. Wizard bid: the grand total of the trades. If no wizard price was
 * typed (e.g. change-bid mode, where only the stored total is loaded), fall back
 * to the single bid price so an existing bid is never zeroed.
 */
export function resolveBidAmount(args: {
  wizardMode: boolean;
  queue: readonly string[];
  wizardPrices: Record<string, unknown>;
  bidPrice: unknown;
}): number {
  if (args.wizardMode) {
    const grand = wizardGrandTotal(args.queue, args.wizardPrices);
    if (grand > 0) return grand;
  }
  return roundDollars(parseFloat(String(args.bidPrice ?? '')) || 0);
}
