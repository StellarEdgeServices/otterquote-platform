/**
 * gh-3560 -- Renew Bid must NOT put `renewals_count` in the quotes UPDATE payload. Production `quotes` has no such
 * column, so PostgREST rejects the whole update and every renewal fails. Nothing reads the count.
 *
 * Static source scan of the shipped bid-form twins (code only; comment lines are ignored):
 *   (a) contractor-bid-form.html has no renewals_count in code           (fails on main)
 *   (b) react utils.ts / bid-form.tsx have no renewals_count / existingRenewalsCount in code  (fails on main)
 * Run: node tests/gh3560-no-renewals-count-in-quote-update.mjs      Exit 0 = all green.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
let fail = 0;
const ok = (c, m) => { if (!c) fail++; console.log((c ? 'PASS: ' : 'FAIL: ') + m); };

const D = 'react-app/app/contractor/bid/[claimId]/';
ok(!/renewals_count/.test(code(rd('contractor-bid-form.html'))), 'static contractor-bid-form.html does not reference renewals_count in code');
for (const f of ['utils.ts', 'bid-form.tsx']) {
  ok(!/renewals_count|existingRenewalsCount/.test(code(rd(D + f))), 'react ' + f + ' does not reference renewals_count / existingRenewalsCount in code');
}
process.exit(fail ? 1 : 0);
