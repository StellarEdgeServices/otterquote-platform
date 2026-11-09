/**
 * gh-3495 (D-267): a multi-trade bid stores and charges the SUM of its trades.
 * Negative control: on main these helpers do not exist and bid-form.tsx sets
 * totalPrice to the last price typed (10000 + 2000 stored 2000, fee 100).
 */
import { describe, it, expect } from 'vitest';
import {
  wizardGrandTotal, wizardTradePrices, resolveBidAmount, priceToCents,
} from '../wizard-total';
import { computeDisclosureFee, buildQuoteInsert } from '../utils';

const QUEUE = ['roofing', 'gutters'];

describe('gh-3495 multi-trade total', () => {
  it('sums the trades: 10000 + 2000 is 12000, not the last price 2000', () => {
    const prices = { roofing: '10000', gutters: '2000' };
    expect(wizardGrandTotal(QUEUE, prices)).toBe(12000);
    expect(resolveBidAmount({ wizardMode: true, queue: QUEUE, wizardPrices: prices, bidPrice: '2000' })).toBe(12000);
  });

  it('fee shown, fee stored and total stored all come from the same total', () => {
    const prices = { roofing: '10000', gutters: '2000' };
    const total = resolveBidAmount({ wizardMode: true, queue: QUEUE, wizardPrices: prices, bidPrice: '2000' });
    const { feeAmount } = computeDisclosureFee(total, 5);
    expect(feeAmount).toBe(600);
    const row = buildQuoteInsert({
      claimId: 'c1', contractorId: 'k1', totalPrice: total, feeBase: total, feePct: 5,
      acceptedAtIso: '2026-11-09T00:00:00.000Z', scopeSummary: '{}', notes: null,
      deckingPricePerSheet: null, fullRedeckPrice: null, supplementAcknowledged: false,
      tradeType: 'roofing', valueAdds: {}, perTradeBreakdown: wizardTradePrices(QUEUE, prices),
      autoRenew: true, warranty: {},
    } as never);
    expect(row.total_price).toBe(12000);
    expect(row.fee_amount).toBe(600);
    expect(row.per_trade_breakdown).toEqual({ roofing: 10000, gutters: 2000 });
  });

  it('rounds typed fractions to whole cents so 9734.095 is never stored', () => {
    expect(priceToCents('9734.095')).toBe(973410);
    expect(wizardTradePrices(['roofing'], { roofing: '9734.095' })).toEqual({ roofing: 9734.1 });
    expect(wizardGrandTotal(['roofing', 'gutters'], { roofing: '9734.095', gutters: '0.1' })).toBe(9734.2);
  });

  it('ignores blank, zero and unselected trades; sums only the queue', () => {
    expect(wizardGrandTotal(['roofing', 'gutters'], { roofing: '5000', gutters: '', siding: '9999' })).toBe(5000);
    expect(wizardTradePrices(['roofing', 'gutters'], { roofing: '5000', gutters: '0' })).toEqual({ roofing: 5000 });
  });

  it('non-wizard bids and change-bid with no wizard prices keep the single bid price', () => {
    expect(resolveBidAmount({ wizardMode: false, queue: [], wizardPrices: {}, bidPrice: '8000' })).toBe(8000);
    expect(resolveBidAmount({ wizardMode: true, queue: QUEUE, wizardPrices: {}, bidPrice: '8000' })).toBe(8000);
  });
});
