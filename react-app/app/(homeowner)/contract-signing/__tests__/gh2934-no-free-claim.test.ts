/**
 * gh-2934 (refs #2745, #2891, PR #2920) -- the D-206 signed-document callout must not call the service "free" beside the
 * $22.63 aerial report fee, on BOTH surfaces (static contract-signing.html and its React twin copy.ts), and both must carry
 * the same approved text. Approved wording sources: heading + sentence 1 + sentence 2 = #2745 6170194316 / CEO 6273560637;
 * sentence 3 clause "other than the report fee above," = Ben 6274463089 item 1. LEGAL-READ: PASS 6301070553 and
 * R-177 SIGNED 6301083060 on PR #2920 head ff09e652 (merged at 93faee01). Read as text, per the repo source-guard convention.
 * FAIL-FIRST: against main the React copy.ts assertions fail (the static page was already fixed by PR #2920).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SIGN_COPY } from '../copy';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..', '..');
const html = readFileSync(resolve(root, 'contract-signing.html'), 'utf8');
const copyTs = readFileSync(resolve(here, '..', 'copy.ts'), 'utf8');

const TITLE = 'No fee to use Otter Quotes';
const BODY =
  'There is no fee to use Otter Quotes. Homeowners pay a small upfront fee for an aerial roof report, rebated in full when they complete a job. The price shown in this contract is the price you pay your contractor — other than the report fee above, there are no separate fees from Otter Quotes.';
const BANNED = ['100% free for Homeowners', 'No Cost to You'];

describe('gh-2934 contract-signing callout carries no "free" claim beside the report fee', () => {
  it('static page: approved title and description present', () => {
    expect(html).toContain(`<div class="callout-title">${TITLE}</div>`);
    expect(html).toContain(`<div class="callout-description">${BODY.replace('—', '&mdash;')}</div>`);
  });
  it('React twin: approved title and body present, identical to the static page', () => {
    expect(SIGN_COPY.noCostTitle).toBe(TITLE);
    expect(SIGN_COPY.noCostBody).toBe(BODY);
  });
  it.each(BANNED)('static page: "%s" is absent (including the dev-only console string)', (s) => {
    expect(html).not.toContain(s);
  });
  it.each(BANNED)('React copy.ts (strings and comments): "%s" is absent', (s) => {
    expect(copyTs).not.toContain(s);
    expect(Object.values(SIGN_COPY).join('\n')).not.toContain(s);
  });
});
