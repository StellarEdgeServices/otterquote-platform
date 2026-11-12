/**
 * gh-3490 (Ben, ruling 6740655614, option A) -- the static bid form's Change Bid / Renew Bid branch writes its own
 * fee_acceptances row for the bid it updated (the fee text on this form says submitting "constitutes your acceptance").
 *
 * Static source scan of contractor-bid-form.html (code only; comment lines are ignored):
 *   (a) the change/renew branch (from `if (changeBidMode && existingQuote) {` to its `} else {`) inserts into fee_acceptances   (fails on main)
 *   (b) that insert names bid_id: existingQuote.id and uses .select('id') and no .single() (gh-3409)                           (fails on main)
 *   (c) it comes AFTER the zero-row check on the quote UPDATE (the acceptance follows a saved update, never precedes it)         (fails on main)
 *   (d) the first-time-bid insert is still there (one write for the new-bid branch)
 * Run: node tests/gh3490-html-change-renew-fee-acceptance.mjs      Exit 0 = all green.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const html = code(fs.readFileSync(path.join(ROOT, 'contractor-bid-form.html'), 'utf8'));
let fail = 0;
const ok = (c, m) => { if (!c) fail++; console.log((c ? 'PASS: ' : 'FAIL: ') + m); };

const start = html.indexOf('if (changeBidMode && existingQuote) {');
const end = html.indexOf('} else {', html.indexOf("bid_update_zero_rows", start));
ok(start > 0 && end > start, 'found the change/renew branch');
const branch = html.slice(start, end);
const zero = branch.indexOf('bid_update_zero_rows');
const ins = branch.indexOf("from('fee_acceptances').insert(");
ok(ins > 0, '(a) the change/renew branch inserts into fee_acceptances');
ok(/bid_id:\s*existingQuote\.id/.test(branch.slice(ins)) && /\.select\('id'\)/.test(branch.slice(ins)) && !/\.single\(\)/.test(branch.slice(ins, ins + 1500)),
  "(b) the insert names bid_id: existingQuote.id, uses .select('id') and no .single()");
ok(zero > 0 && ins > zero, '(c) the acceptance follows the zero-row check on the quote UPDATE');
ok((html.match(/from\('fee_acceptances'\)\.insert\(/g) || []).length === 2, '(d) exactly two fee_acceptances inserts: first-time bid and change/renew');
process.exit(fail ? 1 : 0);
