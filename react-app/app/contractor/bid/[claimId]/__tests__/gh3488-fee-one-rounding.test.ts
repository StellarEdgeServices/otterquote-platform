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
  it('the HTML form no longer computes the fee with a float expression', () => {
    const html = read('contractor-bid-form.html');
    expect(html).toContain('platformFeeDollars(bidAmount, feePct)');
    expect(html).toContain('platformFeeDollars(_bidAmount, _feePct)');
    expect(html).not.toContain('const feeAmount = (bidAmount * feePct) / 100;');
    expect(html).not.toContain('(_bidAmount * _feePct / 100)');
  });
});
