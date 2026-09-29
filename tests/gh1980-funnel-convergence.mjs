/**
 * gh-1980 funnel-page convergence (Ben's ruling, #1980 comment 5889011351,
 * on Marty's 5869732606). hi-4, hi-5, ins-3 and ins-5 were left behind by
 * gh-1980 PR 2: they lazy-load supabase-js 2.112.4 and build a bare
 * `createClient(URL, ANON)` fallback with no storage adapter / storageKey.
 * This test asserts they now match the canonical client setup:
 *   (1) lazy loader points at supabase-js 2.116.0 with the canonical SRI,
 *       crossOrigin = 'anonymous', and no 2.112.4 / old SRI remains;
 *   (2) every createClient( passes the canonical storage adapter + storageKey;
 *   (3) no bare createClient remains;
 *   (4) js/cookie-storage.js is loaded synchronously before the createClient;
 *   (5) flowType is NOT set (that is PR #2336's job);
 *   (6) the credential-sweep allowlist no longer names these pages.
 * Run: node tests/gh1980-funnel-convergence.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['hi-4.html', 'hi-5.html', 'ins-3.html', 'ins-5.html'];
const SRI_NEW = 'sha384-iLddHTLokph6Omwoyid4XKxHaWa6w41BnoEj0q5oOrzmYPpHIKt1wyjReA7s//pP';
const SRI_OLD = 'sha384-ysv13JVP3fufiEXfjML9OdCa/rRbMJvUBOWyor82wfuK8INNZAvmbxHgKIHi+oqz';
const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js';

let pass = 0, fail = 0;
function ok(c, l) { if (c) { console.log('PASS: ' + l); pass++; } else { console.log('FAIL: ' + l); fail++; } }

for (const page of PAGES) {
  const src = fs.readFileSync(path.join(root, page), 'utf8');
  ok(src.includes("s.src = '" + CDN + "'"), page + ' (1) lazy loader src is supabase-js 2.116.0');
  ok(src.includes("s.integrity = '" + SRI_NEW + "'"), page + ' (1) lazy loader integrity is the canonical 2.116.0 SRI');
  ok(/s\.crossOrigin\s*=\s*'anonymous'/.test(src), page + " (1) lazy loader sets crossOrigin = 'anonymous'");
  ok(!src.includes('2.112.4') && !src.includes(SRI_OLD), page + ' (1) no 2.112.4 / old SRI remains');

  const calls = [];
  const re = /createClient\(([^;]*?)\);/gs;
  let m;
  while ((m = re.exec(src)) !== null) calls.push(m[1]);
  ok(calls.length >= 1, page + ' (2) has at least one createClient call -- found ' + calls.length);
  const canonical = /\{\s*auth:\s*\{\s*storage:\s*window\.OtterQuoteCookieStorage,\s*storageKey:\s*window\.OTTERQUOTE_AUTH_STORAGE_KEY\s*\|\|\s*'sb-otterquote-auth'\s*\}\s*\}/;
  ok(calls.length >= 1 && calls.every((c) => canonical.test(c)), page + ' (2) every createClient passes the canonical storage adapter + storageKey');
  ok(!calls.some((c) => c.split(',').length <= 2), page + ' (3) no bare createClient(URL, ANON) remains');
  ok(!calls.some((c) => /flowType/.test(c)), page + ' (5) no flowType set (PR #2336 owns the PKCE flip)');

  const csIdx = src.indexOf('<script src="js/cookie-storage.js"></script>');
  const ccIdx = src.search(/createClient\(/);
  ok(csIdx !== -1 && csIdx < ccIdx, page + ' (4) js/cookie-storage.js is loaded synchronously before createClient');
}

const allow = fs.readFileSync(path.join(root, 'scripts', 'credential-sweep-allowlist.txt'), 'utf8');
for (const page of PAGES) {
  ok(!allow.includes(page), '(6) credential-sweep allowlist no longer names ' + page);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
