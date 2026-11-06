/**
 * gh-3488 / D-267: the fee SHOWN and the fee CHARGED are one figure, in whole cents.
 * The example: a $1,296.10 bid at 5% showed $64.81 and the webhook charged $64.80.
 * Negative control: on main, computeDisclosureFee(1296.1, 5).feeAmount is 64.805 (a half cent), so the
 * whole-cent assertions below fail there.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { computeDisclosureFee, buildFeeAcceptanceInsert } from '../utils';
import { buildFeeDisclosureText } from '../copy';
import { platformFeeCents } from '../../../../../constants/platform-fee';

const repo = path.resolve(__dirname, '../../../../../../');
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');

describe('gh-3488 shown fee equals charged fee', () => {
  it('a $1,296.10 bid at 5% shows $64.81, records 64.81 and charges 6481 cents', () => {
    const d = computeDisclosureFee(1296.1, 5);
    expect(Math.round(d.feeAmount * 100)).toBe(6481);          // whole cents
    expect(d.feeAmount).toBe(64.81);                            // what fee_acceptances.fee_amount records (main: 64.805, a half cent)
    expect(Math.round(d.feeAmount * 100)).toBe(platformFeeCents(1296.1, 5)); // what the webhook charges
    expect(buildFeeDisclosureText(5, d.feeAmount, 1296.1)).toContain('$64.81');
  });

  it('the figure recorded with the acceptance is a whole-cent number', () => {
    const d = computeDisclosureFee(1296.1, 5);
    const row = buildFeeAcceptanceInsert({
      claimId: 'c', contractorId: 'k', bidId: 'b', feePct: 5, feeAmount: d.feeAmount, feeTextDisplayed: 'x',
      acceptedAtIso: '2026-11-05T00:00:00Z', ipAddress: '203.0.113.7', userAgent: 'ua',
    }) as Record<string, unknown>;
    expect(row.fee_amount).toBe(64.81);
  });

  it('shown cents equal charged cents for 100,000 bids at 5% and at 7.5%', () => {
    for (const pct of [5, 7.5]) {
      for (let c = 1; c <= 50_000; c++) {
        const shown = Math.round(computeDisclosureFee(c / 100, pct).feeAmount * 100);
        expect(shown).toBe(platformFeeCents(c / 100, pct));
      }
    }
  });
});

describe('gh-3488 one definition, three copies, no drift', () => {
  const body = (s: string) => {
    const m = s.match(/\/\/ BEGIN platform-fee shared definition[\s\S]*?\/\/ END platform-fee shared definition/);
    if (!m) throw new Error('shared block markers not found');
    return m[0].replace(/^\s+/gm, '').replace(/^export /gm, '').replace(/: number/g, '');
  };
  it('the Edge Function copy, the React copy and the inline HTML copy are the same text', () => {
    const edge = body(read('supabase/functions/_shared/platform-fee.ts'));
    expect(body(read('react-app/constants/platform-fee.ts'))).toBe(edge);
    expect(body(read('contractor-bid-form.html'))).toBe(edge);
  });
  it('the inline HTML block is plain JavaScript (no TypeScript syntax) and runs: $1,296.10 at 5% is 6481 cents', () => {
    const m = read('contractor-bid-form.html').match(/\/\/ BEGIN platform-fee shared definition[\s\S]*?\/\/ END platform-fee shared definition/);
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-new-func
    const run = new Function(`${m![0]}\nreturn { platformFeeCents, platformFeeDollars };`)() as {
      platformFeeCents: (b: number, p: number) => number; platformFeeDollars: (b: number, p: number) => number;
    };
    expect(run.platformFeeCents(1296.1, 5)).toBe(6481);
    expect(run.platformFeeDollars(1296.1, 5)).toBe(64.81);
  });
  it('the HTML form no longer computes the fee with a float expression', () => {
    const html = read('contractor-bid-form.html');
    expect(html).toContain('platformFeeDollars(bidAmount, feePct)');
    expect(html).toContain('platformFeeDollars(_bidAmount, _feePct)');
    expect(html).not.toContain('const feeAmount = (bidAmount * feePct) / 100;');
    expect(html).not.toContain('(_bidAmount * _feePct / 100)');
  });
});

// ── gh-3488 review fixes (LEGAL-READ 6673776959, REVIEW 6673836312) ───────────────────────────────────────────
// Each test below fails on head 234ad802.
function fnSource(html: string, name: string, async_ = false): string {
  const start = html.indexOf(`${async_ ? 'async ' : ''}function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let i = html.indexOf('{', html.indexOf(')', start));
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
function sharedBlock(html: string): string {
  return html.match(/\/\/ BEGIN platform-fee shared definition[\s\S]*?\/\/ END platform-fee shared definition/)![0];
}
type Els = Record<string, { value?: string; textContent?: string }>;
function stubDocument(els: Els) {
  return { getElementById: (id: string) => (els[id] ??= { value: '', textContent: '' }), querySelector: () => null };
}
const usd = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);

describe('gh-3488 review fixes', () => {
  const html = read('contractor-bid-form.html');

  it('(2) the HTML "Platform Fee Breakdown" shows the disclosure figure: $1,296.10 -> $64.81 on both lines', () => {
    const els: Els = { totalPrice: { value: '1296.1' } };
    const run = new Function('document', 'window', 'formatCurrency', 'PLATFORM_FEES', 'updateFeeDisclosure',
      `${sharedBlock(html)}\nfunction currentFeePct() { return window._feePct || 5; }\n${fnSource(html, 'paintFeeBreakdown')}\n${fnSource(html, 'updateFeeCalculator')}\nupdateFeeCalculator();`);
    run(stubDocument(els), { _feePct: 5 }, usd, { contractSigning: 0.05 }, undefined);
    expect(els.feeContractSigning.textContent).toBe('$64.81');
    expect(els.totalFeeAmount.textContent).toBe('$64.81');
    expect(els.yourNet.textContent).toBe('$1,231.29');
  });

  it('(2) the calculator follows the fetched rate, not a hard-coded 5%', () => {
    const els: Els = { totalPrice: { value: '1000' } };
    const run = new Function('document', 'window', 'formatCurrency', 'PLATFORM_FEES', 'updateFeeDisclosure',
      `${sharedBlock(html)}\nfunction currentFeePct() { return window._feePct || 5; }\n${fnSource(html, 'paintFeeBreakdown')}\n${fnSource(html, 'updateFeeCalculator')}\nupdateFeeCalculator();`);
    run(stubDocument(els), { _feePct: 7.5 }, usd, { contractSigning: 0.05 }, undefined);
    expect(els.feeContractSigning.textContent).toBe('$75.00');
  });

  it('(2) the wizard summary net lines use the same whole-cent fee', () => {
    const els: Els = { wizardTradeSummaryRows: {}, wizardGrandTotal: {}, wizardGrandTotalNet: {} };
    const run = new Function('document', 'window', 'formatCurrency', 'wizardTradeQueue', 'wizardTradePrices',
      `${sharedBlock(html)}\nfunction currentFeePct() { return 5; }\n${fnSource(html, 'buildWizardSummary')}\nbuildWizardSummary();`);
    run(stubDocument(els), {}, usd, ['roofing'], { roofing: 1296.1 });
    expect(els.wizardGrandTotalNet.textContent).toBe('Net to you: $1,231.29');
  });

  it('(4) an older fee lookup returning last cannot overwrite the newer bid\'s fee', async () => {
    const els: Els = { totalPrice: { value: '18500' } };
    const win: Record<string, number> = {};
    const lookups: Array<() => void> = [];
    const fetchPlatformFeePercentage = () => new Promise<number>((res) => lookups.push(() => res(5)));
    const run = new Function('document', 'window', 'fetchPlatformFeePercentage', 'updateFeeCheckboxState', 'formatCurrency',
      `${sharedBlock(html)}\nlet _feeDisclosureSeq = 0; let _feeLookupInFlight = null; let _feeAcceptanceCheckbox = null;\nfunction currentFeePct() { return window._feePct || 5; }\n${fnSource(html, 'paintFeeBreakdown')}\n${fnSource(html, 'paintFeeDisclosure')}\n${fnSource(html, 'updateFeeDisclosure', true)}\nreturn updateFeeDisclosure;`);
    const updateFeeDisclosure = run(stubDocument(els), win, fetchPlatformFeePercentage, () => {}, usd) as () => Promise<void>;
    const older = updateFeeDisclosure();                 // bid $18,500 at call time
    els.totalPrice.value = '25000';
    const newer = updateFeeDisclosure();                 // bid $25,000
    lookups[1]();                                        // the newer lookup returns first
    await newer;
    expect(win._feeAmount).toBe(1250);
    lookups[0]();                                        // the older one returns last
    await older;
    expect(win._feeAmount).toBe(1250);                   // 234ad802: 925
    expect(els.feeDollarDisplay.textContent).toBe('$1,250.00');
  });

  it('(4) submit derives the accepted figure from the bid being submitted, not from window._feeAmount', () => {
    expect(html).toContain('_feeAmount = platformFeeDollars(_bidAmount, _feePct);');
    expect(html).not.toContain('window._feeAmount || platformFeeDollars');
    expect(html).toContain('window._feeAmount = _feeAmount;');
  });

  it('(3) both forms normalise the typed bid to whole cents before it is shown, stored and charged', () => {
    // one snapshot at submit: whole cents, taken once; accepted fee, stored price and charge basis all use it
    expect(html).toContain("const _snapBid = wholeCentDollars(parseFloat(document.getElementById('totalPrice').value) || 0)");
    expect(html).toContain('const _bidAmount = _snapBid;');
    expect(html).toContain('const totalPrice = _snapBid;');
    expect(read('react-app/app/contractor/bid/[claimId]/bid-form.tsx'))
      .toContain('const bidAmount = wholeCentDollars(parseFloat(form.bidPrice) || 0)');
  });

  it('(3) a bid typed with a fraction of a cent: $9,734.095 shows $486.71, records 486.71 and charges 48671 (234ad802: 486.70)', () => {
    const d = computeDisclosureFee(9734.095, 5);
    expect(d.feeAmount).toBe(486.71);
    expect(Math.round(d.feeAmount * 100)).toBe(platformFeeCents(9734.095, 5));
    expect(platformFeeCents(9734.095, 5)).toBe(platformFeeCents(9734.1, 5)); // what numeric(12,2) stores
    expect(computeDisclosureFee(128.295, 5).feeAmount).toBe(6.42);            // review's 641-vs-642 case
  });

  it('(1) process-auto-bids emails the charged figure', () => {
    const src = read('supabase/functions/process-auto-bids/index.ts');
    expect(src).toContain('const feeAmount = platformFeeDollars(rcvAmount, resolvedFeePct);');
    expect(src).not.toContain('Math.round(rcvAmount * (resolvedFeePct / 100) * 100) / 100');
  });
});
