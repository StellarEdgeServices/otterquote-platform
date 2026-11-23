/**
 * gh-3863 -- bids.html shows "Contract Signed" only on the selected contractor's card. On a contract_signed claim a
 * declined/other quote's card shows "Not Selected" (it showed "Contract Signed" before; found on is_test claim 8dcf76f1).
 *
 * HOW: extracts the real `const actionBtn = (function() {...})();` from bids.html and runs it for a selected and a
 * declined bid on a contract_signed claim, plus an awarded claim (control that must not change).
 * Negative control: ROOT=<checkout of main before this change> node tests/gh3863-bids-contract-signed-selected-only.mjs  (expected exit 1)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT ? path.resolve(process.env.ROOT) : path.resolve(here, '..');
let fail = 0;
const check = (name, cond) => { if (!cond) fail++; console.log((cond ? 'PASS: ' : 'FAIL: ') + name); };

const html = fs.readFileSync(path.join(ROOT, 'bids.html'), 'utf8');
const m = html.match(/const actionBtn = (\(function\(\) \{[\s\S]*?\n        \}\)\(\));/);
check('actionBtn IIFE found in bids.html', !!m);
if (m) {
  const run = (currentClaim, bid, isWithdrawn = false, isExpired = false) =>
    new Function('currentClaim', 'bid', 'isWithdrawn', 'isExpired', 'return ' + m[1] + ';')(currentClaim, bid, isWithdrawn, isExpired);
  const signed = { id: 'c1', status: 'contract_signed', selected_contractor_id: 'K2' };
  const sel = run(signed, { id: 'q2', contractor_id: 'K2', bid_status: 'active' });
  const dec = run(signed, { id: 'q1', contractor_id: 'K1', bid_status: 'declined' });
  check('selected contractor card shows Contract Signed', sel.includes('Contract Signed'));
  check('declined contractor card does NOT show Contract Signed', !dec.includes('Contract Signed'));
  check('declined contractor card shows Not Selected', dec.includes('Not Selected'));
  const aw = { id: 'c1', status: 'awarded', selected_contractor_id: 'K2' };
  check('awarded claim: selected card unchanged (View Contract Status)', run(aw, { id: 'q2', contractor_id: 'K2' }).includes('View Contract Status'));
  check('awarded claim: other card unchanged (Not Selected)', run(aw, { id: 'q1', contractor_id: 'K1' }).includes('Not Selected'));
}
console.log(fail ? `FAILED (${fail})` : 'ALL PASS');
process.exit(fail ? 1 : 0);
