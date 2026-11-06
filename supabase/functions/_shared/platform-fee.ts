// BEGIN platform-fee shared definition (gh-3488, D-267). Byte-identical in three places (parity test:
// react-app/app/contractor/bid/[claimId]/__tests__/platform-fee-parity.test.ts): this file,
// react-app/constants/platform-fee.ts and the inline copy in contractor-bid-form.html.
// The fee the contractor is SHOWN and the fee that is CHARGED are this one figure, in whole cents,
// rounded half-up on the exact decimal product (bid cents x pct hundredths / 10000), integers only.
// It equals round(pct/100 * total_price, 2) in Postgres numeric (quotes.fee_amount, gh-2519 trigger).
export function platformFeeCents(bidAmount: number, feePct: number): number {
  const bid = Number(bidAmount);
  const pct = Number(feePct);
  if (!Number.isFinite(bid) || !Number.isFinite(pct) || bid <= 0 || pct <= 0) return 0;
  const bidCents = Math.round(bid * 100);
  const pctHundredths = Math.round(pct * 100);
  const t = bidCents * pctHundredths + 5000;
  return (t - (t % 10000)) / 10000;
}
export function platformFeeDollars(bidAmount: number, feePct: number): number {
  return platformFeeCents(bidAmount, feePct) / 100;
}
// END platform-fee shared definition
