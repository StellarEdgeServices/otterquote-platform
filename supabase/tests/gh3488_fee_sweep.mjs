// gh-3488 / D-267 sweep. Run: node --experimental-strip-types supabase/tests/gh3488_fee_sweep.mjs [N]
// Compares, over many bids, the fee the contractor is SHOWN with the fee that is CHARGED, before and after.
//   old shown   = (bid * pct) / 100 formatted with toLocaleString('en-US', currency)  (bid-form.tsx / contractor-bid-form.html)
//   old charged = Math.round(total_price * (pct / 100) * 100)                          (docusign-webhook, create-payment-intent)
//   new shown   = platformFeeDollars(bid, pct) formatted the same way                  (shared definition, display path)
//   new charged = platformFeeCents(bid, pct)                                           (shared definition, charge path)
//   (fractional-cent bids and the auto-bid email / calculator lines are swept in sweepFractional below)
//   reference   = BigInt exact half-up of bidCents * pctHundredths / 10000             (independent of the shared code)
import { platformFeeCents, platformFeeDollars, wholeCentDollars } from '../functions/_shared/platform-fee.ts';

const N_EXHAUSTIVE = Number(process.argv[2] || 1_000_000);   // every bid from $0.01 up, in cents
const N_RANDOM = Number(process.argv[3] || 1_000_000);       // seeded pseudo-random bids up to $2,000,000.00
const PRODUCTION_RATES = [5.0];                               // platform_fee_config in production holds one row: 5.00
const EXTRA_RATES = [2.5, 3, 6.25, 7.5, 10];                  // supplementary, fewer bids each

const fmt = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const centsOfFmt = (s) => Number(s.replace(/[$,]/g, '').replace('.', ''));
const refCents = (bidCents, pctH) => Number((BigInt(bidCents) * BigInt(pctH) + 5000n) / 10000n);
let seed = 123456789; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function sweep(pct, bidsCents) {
  const r = { pct, bids: 0, oldShownVsOldCharged: 0, newShownVsNewCharged: 0, newShownVsRef: 0, newChargedVsRef: 0,
              newChargedVsOldShown: 0, newChargeHigherThanOldShown: 0, newChargeLowerThanOldShown: 0, oldChargedVsRef: 0 };
  const pctH = Math.round(pct * 100);
  for (const bc of bidsCents) {
    const bid = bc / 100;
    const oldShown = centsOfFmt(fmt((bid * pct) / 100));
    const oldCharged = Math.round(bid * (pct / 100) * 100);
    const newShown = centsOfFmt(fmt(platformFeeDollars(bid, pct)));
    const newCharged = platformFeeCents(bid, pct);
    const ref = refCents(bc, pctH);
    r.bids++;
    if (oldShown !== oldCharged) r.oldShownVsOldCharged++;
    if (newShown !== newCharged) r.newShownVsNewCharged++;
    if (newShown !== ref) r.newShownVsRef++;
    if (newCharged !== ref) r.newChargedVsRef++;
    if (oldCharged !== ref) r.oldChargedVsRef++;
    if (newCharged !== oldShown) r.newChargedVsOldShown++;
    if (newCharged > oldShown) r.newChargeHigherThanOldShown++;
    if (newCharged < oldShown) r.newChargeLowerThanOldShown++;
  }
  return r;
}
function* exhaustive(n) { for (let c = 1; c <= n; c++) yield c; }
function* random(n) { for (let i = 0; i < n; i++) yield 1 + Math.floor(rnd() * 200_000_000); }

// Fractional inputs (review of 234ad802): a bid typed with 3 or 4 decimals. Postgres numeric(12,2) stores the typed
// decimal text rounded half-up, and the charge reads the stored value. 234ad802's function used Math.round(bid * 100).
//   storedCents = floor((typedTenThousandths + 50) / 100);   ref fee = BigInt half-up of storedCents x pctHundredths
function sweepFractional(pct, typedTenThousandths) {
  const r = { pct, typedBids: 0, newShownVsCharged: 0, newShownBidVsStoredBid: 0, newEmailVsCharged: 0, calcVsCharged: 0,
              old234adShownVsCharged: 0, oldEmailVsCharged: 0 };
  const pctH = Math.round(pct * 100);
  for (const t of typedTenThousandths) {
    const typed = t / 10000;                                      // parseFloat of the decimal text
    const storedCents = Math.floor((t + 50) / 100);
    const charged = refCents(storedCents, pctH);                  // what the webhook charges from the stored bid
    const shown = platformFeeCents(typed, pct);                   // what the form shows/records after normalising
    r.typedBids++;
    if (shown !== charged) r.newShownVsCharged++;
    if (Math.round(wholeCentDollars(typed) * 100) !== storedCents) r.newShownBidVsStoredBid++;
    if (Math.round(platformFeeDollars(typed, pct) * 100) !== charged) r.newEmailVsCharged++;        // auto-bid email figure
    if (Math.round(platformFeeDollars(typed, pct) * 100) !== charged) r.calcVsCharged++;            // calculator line (same function)
    const oldShown = refCents(Math.round(typed * 100), pctH);     // 234ad802: bid * 100 rounded as a float
    if (oldShown !== charged) r.old234adShownVsCharged++;
    const oldEmail = Math.round(Math.round(typed * (pct / 100) * 100)) ;    // process-auto-bids before this fix
    if (oldEmail !== charged) r.oldEmailVsCharged++;
  }
  return r;
}
function* thousandths(n) { for (let k = 1; k <= n; k++) yield k * 10; }                 // x.xx0 steps are whole-cent; add the fractions below
function* fractional(n) { for (let c = 1; c <= n; c++) { yield c * 100 + 50; yield c * 100 + 49; yield c * 100 + 5; } } // x.xx5, x.xx49, x.xx05
function* fractionalRandom(n) { for (let i = 0; i < n; i++) yield 1 + Math.floor(rnd() * 20_000_000_00); }   // up to $2,000,000.0000

const rows = [];
for (const p of PRODUCTION_RATES) {
  rows.push(sweep(p, exhaustive(N_EXHAUSTIVE)));
  rows.push(sweep(p, random(N_RANDOM)));
}
for (const p of EXTRA_RATES) rows.push(sweep(p, random(Math.floor(N_RANDOM / 2))));
console.table(rows);
const frows = [sweepFractional(5.0, fractional(700_000)), sweepFractional(5.0, fractionalRandom(1_000_000))];
for (const p of EXTRA_RATES) frows.push(sweepFractional(p, fractionalRandom(250_000)));
console.table(frows);
const fbad = frows.reduce((a, r) => a + r.newShownVsCharged + r.newShownBidVsStoredBid + r.newEmailVsCharged + r.calcVsCharged, 0);
console.log(`fractional bids swept at 5.00: ${frows[0].typedBids + frows[1].typedBids}; all fractional: ${frows.reduce((a, r) => a + r.typedBids, 0)}`);
console.log(`FRACTIONAL new shown/stored-bid/email/calculator != charged: ${fbad}`);
console.log(`FRACTIONAL 234ad802 shown != charged: ${frows.reduce((a, r) => a + r.old234adShownVsCharged, 0)}; old auto-bid email != charged: ${frows.reduce((a, r) => a + r.oldEmailVsCharged, 0)}`);
const total = rows.reduce((a, r) => a + r.bids, 0);
const prod = rows.slice(0, 2 * PRODUCTION_RATES.length).reduce((a, r) => a + r.bids, 0);
const bad = rows.reduce((a, r) => a + r.newShownVsNewCharged + r.newShownVsRef + r.newChargedVsRef, 0);
console.log(`bids swept at the production rate(s) ${PRODUCTION_RATES.join(',')}: ${prod}; all bids swept: ${total}`);
console.log(`NEW shown != NEW charged, or either != exact reference: ${bad}`);
console.log(`OLD shown != OLD charged: ${rows.reduce((a, r) => a + r.oldShownVsOldCharged, 0)}`);
console.log(`NEW charge HIGHER than the OLD shown figure: ${rows.reduce((a, r) => a + r.newChargeHigherThanOldShown, 0)}; LOWER: ${rows.reduce((a, r) => a + r.newChargeLowerThanOldShown, 0)}`);
process.exit(bad === 0 && fbad === 0 ? 0 : 1);
