// BEGIN platform-fee shared definition (gh-3488, D-267). Byte-identical in three places (parity test:
// react-app/app/contractor/bid/[claimId]/__tests__/gh3488-fee-one-rounding.test.ts): this file,
// react-app/constants/platform-fee.ts and the inline copy in contractor-bid-form.html.
// The fee the contractor is SHOWN and the fee that is CHARGED are this one figure, in whole cents,
// rounded half-up on the exact decimal product (bid cents x pct hundredths / 10000), integers only.
// It equals round(pct/100 * total_price, 2) in Postgres numeric (quotes.fee_amount, gh-2519 trigger).
// A typed bid is first normalised to whole cents the way Postgres numeric(12,2) stores it (half-up on
// the decimal text), so a bid typed with a fraction of a cent shows and charges the same fee.
export function wholeCents(amount: number): number {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const viaText = Math.round(Number(n + 'e2'));
  return Number.isFinite(viaText) ? viaText : Math.round(n * 100);
}
export function wholeCentDollars(amount: number): number {
  return wholeCents(amount) / 100;
}
export function platformFeeCents(bidAmount: number, feePct: number): number {
  const bidCents = wholeCents(bidAmount);
  const pctHundredths = wholeCents(feePct);
  if (bidCents <= 0 || pctHundredths <= 0) return 0;
  const t = bidCents * pctHundredths + 5000;
  return (t - (t % 10000)) / 10000;
}
export function platformFeeDollars(bidAmount: number, feePct: number): number {
  return platformFeeCents(bidAmount, feePct) / 100;
}
// END platform-fee shared definition
