/**
 * gh-3569 follow-up -- Ben's DECIDED copy ruling (issue comment 6775144071, answering Q2 6742757848):
 *   label "Roofing price", help text "Price for the roofing portion. Your bid total is the sum of all trades.",
 *   the platform-fee sentence stays on the bid-total line, and the fee-acceptance disclosure (D-214/D-215) is untouched.
 * Static source check on contractor-bid-form.html (no browser). Exit 0 = all green.
 * Negative control: ROOT=<checkout of main before this change> node tests/gh3569-roofing-price-copy.mjs  (expected exit 1)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT ? path.resolve(process.env.ROOT) : path.resolve(here, '..');
const html = fs.readFileSync(path.join(ROOT, 'contractor-bid-form.html'), 'utf8');
let fail = 0;
const ok = (c, l) => { if (!c) fail++; console.log((c ? 'PASS: ' : 'FAIL: ') + l); };
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const clean = (s) => s.replace(/<[^>]*>/g, '').trim();

const sec = html.match(/<div class="form-section" id="retailPriceSection"[^>]*>([\s\S]*?)<\/div>\s*\n\s*<div class="form-group" id="brandProductGroup"/);
ok(!!sec, 'retailPriceSection found');
const body = sec ? sec[1] : '';
const label = (body.match(/<label class="form-label required"[^>]*>([\s\S]*?)<\/label>/) || [])[1];
const help = (body.match(/<p [^>]*>([\s\S]*?)<\/p>/) || [])[1];
ok(label === 'Roofing price', 'roofing price label is exactly "Roofing price"');
ok(help === 'Price for the roofing portion. Your bid total is the sum of all trades.', 'roofing price help text is exact');
ok(!/Platform fees are deducted/.test(body), 'platform-fee sentence is not on the roofing field');
ok(!/Total Bid Price/.test(body), 'roofing field no longer labelled "Total Bid Price"');

const FEE = 'Platform fees are deducted from this amount per the breakdown below.';
ok(html.split(FEE).length - 1 === 1, 'platform-fee sentence appears exactly once');
const calc = html.indexOf('id="feeCalculatorSection"');
const bid = html.indexOf('id="displayBid"');
const note = html.indexOf('id="bidTotalFeeNote"');
const total = html.indexOf('<span>Total Platform Fee</span>');
ok(calc > 0 && bid > calc && note > bid && note < total, 'fee sentence sits in the fee calculator on the bid-total ("Your Bid") line, above the breakdown');
ok(clean((html.match(/id="bidTotalFeeNote"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '') === FEE, 'fee sentence is word-for-word unchanged');

const a = html.indexOf('<!-- D-214/D-215: Fee Disclosure & Acknowledgment -->');
const b = html.indexOf('<button type="submit" form="bidForm"');
const blk = html.slice(a, b);
ok(a > 0 && b > a && sha(blk) === '592baf58ab2022566c53cfc0bc8a8034010cf6e9244e9338076d9cd12e6ed155', 'D-214/D-215 fee-acceptance disclosure block is byte-identical to main');
const c = html.indexOf('<div class="submit-disclaimer">');
const blk2 = html.slice(c, html.indexOf('</div>', c) + 6);
ok(sha(blk2) === 'e7dd1dd53629da1c85cdeb05d75561a022e42f8effe0a67676ca3c53895435e8', 'submit disclaimer is byte-identical to main');

console.log(fail ? `FAILED (${fail})` : 'ALL PASS');
process.exit(fail ? 1 : 0);
