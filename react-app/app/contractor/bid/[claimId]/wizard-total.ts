/**
 * gh-3495 (D-267): a multi-trade (wizard) bid's total is the SUM of its trades,
 * in whole cents. The Grand Total the contractor sees, quotes.total_price, the
 * fee shown and accepted, quotes.fee_amount and the charge
 * (docusign-webhook: total_price x pct) must all be derived from this one number.
 *
 * Pure and ASCII-only. No fee rate and no displayed wording lives here.
 */

/**
 * Parse one typed price to whole cents with a decimal-safe round half up; blank,
 * negative or non-numeric -> 0. Math.round(n * 100) is wrong for inputs such as
 * 9734.095 (973409.4999...), so the third decimal digit is read from the string.
 */
export function priceToCents(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  if (!(n > 0) || !Number.isFinite(n) || n >= 1e12) return 0;
  const [whole, frac] = n.toFixed(10).split('.');
  let cents = parseInt(whole, 10) * 100 + parseInt(frac.slice(0, 2), 10);
  if (frac.charCodeAt(2) >= 53) cents += 1; // third decimal digit >= 5
  return cents;
}

/**
 * Seed the wizard's per-trade price strings from a stored per_trade_breakdown, so
 * Change Bid / Renew of a stored multi-trade bid starts from every trade's price
 * (not from the stored grand total, and not from the one trade the contractor edits).
 */
export function seedWizardPrices(breakdown: unknown): Record<string, string> {
  let bd = breakdown;
  if (typeof bd === 'string') { try { bd = JSON.parse(bd); } catch { bd = null; } }
  const out: Record<string, string> = {};
  if (!bd || typeof bd !== 'object') return out;
  for (const [trade, v] of Object.entries(bd as Record<string, unknown>)) {
    const c = priceToCents(v);
    if (c > 0) out[trade] = String(c / 100);
  }
  return out;
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
 * to the single bid price, unchanged, so an existing bid is never zeroed.
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
  // Non-wizard, or no wizard price typed: the bid price passes through UNCHANGED (never rounded).
  return parseFloat(String(args.bidPrice ?? '')) || 0;
}
