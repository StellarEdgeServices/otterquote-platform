/**
 * gh-3619 / D-388 -- the retired "every contractor" measurement claim must not appear on any public surface.
 * D-388 wording: "professional measurements that contractors use to bid".
 * Source-level guard (no browser, no network, no database). Scans tracked public files:
 *   root *.html / *.txt / *.xml, llms.txt, js/, partners/, guides/, blog/, react-app/app (excluding __tests__).
 * Retired shapes: "measurements that are used by every contractor", "measurements that every contractor uses",
 * "measurements that every contractor bids from". Unrelated uses ("ask every contractor the same questions") are not flagged.
 * Negative controls: the scanner flags known-bad strings and ignores unrelated "every contractor" uses and the D-388 wording.
 * Run: node tests/gh3619-no-every-contractor-measurement-claim.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }

const RETIRED_RE = /measurements\s+(?:that\s+(?:are\s+used\s+by\s+every\s+contractor|every\s+contractor\s+(?:uses|bids\s+from))|(?:used|that\s+are\s+used)\s+by\s+every\s+contractor)/gi;
function retiredHits(text) {
  const t = text.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  return t.match(RETIRED_RE) || [];
}

const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
function isPublic(f) {
  if (f.includes('__tests__') || f.includes('node_modules')) return false;
  if (!f.includes('/')) return /\.(html|txt|xml)$/i.test(f);
  if (/^(js|partners|guides|blog)\//.test(f)) return /\.(html|js|txt|xml)$/i.test(f);
  if (f.startsWith('react-app/app/')) return /\.(ts|tsx|js|jsx)$/.test(f);
  return false;
}
const files = tracked.filter(isPublic);
ok(files.includes('llms.txt') && files.includes('re-1.html') && files.includes('partners/roof-damage-found-before-closing.html'),
  'S0 scan set includes llms.txt, re-1.html and partners/roof-damage-found-before-closing.html (' + files.length + ' files)');

const offenders = [];
for (const f of files) {
  const hits = retiredHits(fs.readFileSync(path.join(repoRoot, f), 'utf8'));
  if (hits.length) offenders.push(f + ' x' + hits.length);
}
ok(offenders.length === 0, 'S1 no public file carries the retired measurement claim' + (offenders.length ? ' -- ' + offenders.join('; ') : ''));

ok(retiredHits('professional measurements that are used by every contractor.').length === 1, 'N1 scanner flags "used by every contractor"');
ok(retiredHits('professional measurements that every contractor uses.').length === 1, 'N2 scanner flags "every contractor uses"');
ok(retiredHits('professional measurements that every contractor bids from.').length === 1, 'N3 scanner flags "every contractor bids from"');
ok(retiredHits('Ask every contractor the same questions in writing.').length === 0, 'N4 scanner ignores unrelated "every contractor"');
ok(retiredHits('professional measurements that contractors use to bid.').length === 0, 'N5 scanner passes the D-388 wording');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
