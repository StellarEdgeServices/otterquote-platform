/**
 * gh-2355 (CodeQL #92, js/clear-text-storage-of-sensitive-data) -- the partner signup
 * pages must not persist partner PII (name, email, phone, company: the register_partner
 * rpcArgs) in localStorage. The pending-registration marker moved to sessionStorage
 * (tab-scoped, 24h TTL); a legacy localStorage copy is purged. Static guard over EVERY page
 * that used the key, the dashboard reader and js/partner-registration.js.
 * Behavioural coverage (page really writes the marker, resume replays the same args):
 * tests/gh2274-partner-dup-email-error.mjs and tests/gh2282-dashboard-complete-registration.mjs.
 *
 * Run: node tests/gh2355-partner-pii-not-in-localstorage.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(c, label) { if (c) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }
const K = 'oq_partner_pending_registration';
const has = (src, call) => src.includes(call + '(' + "'" + K + "'") || src.includes(call + "( '" + K + "'");
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html') && read(f).includes("'" + K + "'"));
ok(pages.length >= 14, 'discovery: >= 14 signup pages use the marker, found ' + pages.length);
for (const f of pages) {
  const src = read(f);
  ok(!has(src, 'localStorage.setItem'), f + ': never writes the PII marker to localStorage');
  ok(!has(src, 'localStorage.getItem'), f + ': never reads the PII marker from localStorage');
  ok(has(src, 'sessionStorage.setItem'), f + ': writes the marker to sessionStorage');
  ok(has(src, 'sessionStorage.getItem'), f + ': reads the marker from sessionStorage');
  ok(has(src, 'localStorage.removeItem'), f + ': purges any legacy localStorage copy');
  ok(!/pendingMarker\.ts[^\n]*7 \* 24/.test(src), f + ': marker TTL is no longer 7 days');
}
const dash = read('partner-dashboard.html');
ok(/readMarker\(sessionStorage,/.test(dash) && /complete\(sb, params, sessionStorage\)/.test(dash), 'partner-dashboard.html: resume reads/clears the marker in sessionStorage');
ok(!/readMarker\(localStorage/.test(dash) && !/complete\(sb, params, localStorage\)/.test(dash), 'partner-dashboard.html: no localStorage marker read');
const lib = read('js/partner-registration.js');
ok(/TTL_MS = 24 \* 60 \* 60 \* 1000/.test(lib), 'js/partner-registration.js: 24h TTL');
// No other file may write the key to localStorage.
let hits = '';
try { hits = execSync("git grep -n \"localStorage.setItem('" + K + "'\" -- . \":!tests\"", { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { hits = ''; /* git grep exit 1 = no match */ }
ok(hits === '', 'repo-wide: no localStorage.setItem of the marker outside tests -- ' + JSON.stringify(hits));
console.log('\nTOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
