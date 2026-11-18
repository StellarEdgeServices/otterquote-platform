/**
 * gh-3492 (Dustin, "APproved", recorded 2026-11-09T14:13:31Z on #3492) -- the bid form shows the card processing fee
 * directly after the approved #547 sentence, in the static page (both places the sentence appears) and in the React copy.
 *
 * Static source scan (exact text, character for character):
 *   (a) contractor-bid-form.html: both #547 sentences are followed by the approved line              (fails on main)
 *   (b) react copy.ts BID_COPY.fee.feeExplainer ends with #547 sentence + approved line               (fails on main)
 * Run: node tests/gh3492-bid-form-card-fee-line.mjs      Exit 0 = all green.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let fail = 0;
const ok = (c, m) => { if (!c) fail++; console.log((c ? 'PASS: ' : 'FAIL: ') + m); };

const S547 = 'You will never be charged a fee that was not displayed to you at submission.';
const LINE = 'If you pay by card, a processing fee of 2.9% + $0.30 is added to the platform fee shown above, as stated in Section 7.7 of your Contractor Partner Agreement.';
const count = (s, t) => s.split(t).length - 1;

const html = rd('contractor-bid-form.html');
ok(count(html, S547) === 2, 'static page has the #547 sentence in exactly two places');
ok(count(html, S547 + ' ' + LINE) === 2, '(a) static page: the approved line directly follows the #547 sentence in both places');
const copy = rd('react-app/app/contractor/bid/[claimId]/copy.ts');
ok(count(copy, S547 + ' ' + LINE + "',") === 1, '(b) react copy.ts: feeExplainer ends with the #547 sentence + the approved line');
process.exit(fail ? 1 : 0);
