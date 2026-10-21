/**
 * gh-2564 -- bids.html hides a bid retired as bid_status 'superseded' (the homeowner switched away from it).
 * It is filtered where the quotes are loaded, so the card grid, the compare grid, the best-price calculation and the
 * select / profile handlers (all of which read the `bids` array) never see it. No customer wording is added.
 *
 * Checks: (1) loadBids() assigns bids from a filter that drops 'superseded'; (2) behaviourally, that exact expression
 * keeps live / expired / cancelled bids and drops the superseded one.
 * Negative control: ROOT=<checkout of main before this change> node tests/gh2564-bids-html-superseded-hidden.mjs  (expected exit 1)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT ? path.resolve(process.env.ROOT) : path.resolve(here, '..');
let fail = 0;
const check = (name, cond) => { if (!cond) fail++; console.log((cond ? 'PASS: ' : 'FAIL: ') + name); };

const html = fs.readFileSync(path.join(ROOT, 'bids.html'), 'utf8');
const m = html.match(/bids = (data\.filter\(b => b\.bid_status !== 'superseded'\));/);
check("loadBids assigns bids = data.filter(b => b.bid_status !== 'superseded')", !!m);
check('no unfiltered "bids = data;" assignment remains', !/^\s*bids = data;\s*$/m.test(html));

if (m) {
  const filter = new Function('data', 'return ' + m[1] + ';');
  const rows = [
    { id: 'live', bid_status: 'active' }, { id: 'old', bid_status: 'superseded' },
    { id: 'exp', bid_status: 'expired' }, { id: 'wd', bid_status: 'cancelled' },
  ];
  const ids = filter(rows).map(r => r.id).join(',');
  check('superseded dropped; active, expired, cancelled kept', ids === 'live,exp,wd');
}
console.log(fail ? `FAILED (${fail})` : 'ALL PASS');
process.exit(fail ? 1 : 0);
