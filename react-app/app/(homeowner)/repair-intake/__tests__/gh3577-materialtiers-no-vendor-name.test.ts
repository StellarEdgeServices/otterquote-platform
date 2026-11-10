/**
 * Regression test for gh-3577 / D-312: no vendor is named on the public site.
 * Companion of PR #3599 (static repair-intake.html). MaterialTiers.tsx printed the
 * material-test lab vendor's name in the Tier 4 accordion, the mailing block and
 * the request button. Offer and price wording must stay unchanged.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'MaterialTiers.tsx'),
  'utf8',
);

describe('gh-3577 MaterialTiers vendor-name removal (D-312)', () => {
  it('prints no vendor name (ITEL as a standalone word, any case)', () => {
    // CSS class ids (ri-itel-*) are shared with styles.ts and are not rendered text.
    const hits = src
      .replace(/ri-itel-[a-z]+/g, 'ri-lab-id')
      .split('\n')
      .map((l, i) => `L${i + 1}: ${l.trim()}`)
      .filter((l) => /\bITEL\b/i.test(l));
    expect(hits).toEqual([]);
  });

  it('keeps the offer and price wording unchanged', () => {
    expect(src).toContain('<strong>💰 Starting at $75</strong> — refunded if you use an Otter');
    expect(src).toContain('Quotes contractor');
    expect(src).toContain('<span className="ri-tier-price">$75-100</span>');
  });

  it('uses the same neutral wording as PR #3599', () => {
    expect(src).toContain('Tier 4: Lab Analysis');
    expect(src).toContain('Lab Sample Mailing Address:');
    expect(src).toContain('Attn: Sample Receiving');
    expect(src).not.toContain('Material Testing Lab');
    expect(src).toContain('7 Westport Court');
    expect(src).toContain('Phone: (800) 783-4835');
    expect(src).toContain('Lab analysis request noted');
    expect(src).toContain('Request Lab Analysis ($75)');
  });
});
