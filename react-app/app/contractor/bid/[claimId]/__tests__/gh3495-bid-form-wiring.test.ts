/**
 * gh-3495 (D-267): source-level wiring check. The React bid form must take its
 * bid amount (fee shown, fee accepted, total_price, fee_amount) from the sum of
 * the wizard trades, and store a cent-rounded breakdown. On main bid-form.tsx
 * read `parseFloat(form.bidPrice)` (the last price typed), so this fails there.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const src = readFileSync(join(__dirname, '..', 'bid-form.tsx'), 'utf8');

describe('gh-3495 bid-form.tsx wiring', () => {
  it('derives bidAmount from resolveBidAmount over the wizard trades', () => {
    expect(src).toContain("from './wizard-total'");
    expect(src).toMatch(/const bidAmount = resolveBidAmount\(\{[^}]*wizardMode[^}]*queue: wizard\.queue[^}]*wizardPrices[^}]*bidPrice: form\.bidPrice/);
  });

  it('no longer takes the bid amount from the last price typed', () => {
    expect(src).not.toMatch(/const bidAmount = parseFloat\(form\.bidPrice\)/);
  });

  it('stores the cent-rounded per-trade breakdown', () => {
    expect(src).toMatch(/perTradeBreakdown = wizardMode \? wizardTradePrices\(wizard\.queue, wizardPrices\)/);
  });

  it('N3: seeds the wizard prices from the stored per_trade_breakdown and shows cent-rounded review prices', () => {
    expect(src).toMatch(/seedWizardPrices\(existingQuote\?\.per_trade_breakdown\)/);
    expect(src).toMatch(/formatCurrency\(wizardRounded\[t\]\)/);
  });

  it('fee and total_price both follow bidAmount', () => {
    expect(src).toMatch(/computeDisclosureFee\(bidAmount, feePct\)/);
    expect(src).toMatch(/totalPrice: bidAmount/);
  });
});
