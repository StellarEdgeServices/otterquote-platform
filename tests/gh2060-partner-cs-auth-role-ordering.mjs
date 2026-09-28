/**
 * gh-2060 round-4 hardening 3 — a failed / duplicate partner signup must not
 * leave a `cs_auth_role` breadcrumb behind.
 *
 * Round-4 review (5876196684, "Not blocking" item 3, carried from round 3 and
 * from the gh-2274 follow-up F5 dedup note): on the partner/funnel signup
 * pages, `localStorage.setItem('cs_auth_role', agentType)` used to run BEFORE
 * the duplicate-email early return, so a rejected signup still wrote the
 * breadcrumb (and, since PR #2253, its `cs_auth_role_at` stamp), which
 * /auth-callback then trusted for 24h on that browser.
 *
 * On current `main` the password-path writers already sit AFTER the
 * `register_partner` RPC and its `partner_exists` / duplicate early returns
 * (the gh-2282 signup-before-register_partner rework moved them). This test
 * PINS that ordering so it cannot silently regress, discovering the pages
 * instead of listing them (same approach as
 * gh2060-static-cs-auth-role-writers.mjs).
 *
 * Rules, per `cs_auth_role` write site in a root *.html file that also calls
 * `register_partner`:
 *   (1) A Google-redirect writer (an `Auth.signInWithGoogle(` call follows the
 *       write within 300 chars) is exempt from the ordering rule — it must
 *       write BEFORE the redirect because the page unloads — but its `catch`
 *       must remove both keys again (the failed-attempt path).
 *   (2) Every other writer must come AFTER a `register_partner` RPC call AFTER
 *       the `partner_exists` early-return block, i.e. after the last
 *       `return;` that belongs to the duplicate handling.
 *
 * Run: node tests/gh2060-partner-cs-auth-role-ordering.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const WRITE_RE = /localStorage\.setItem\(\s*['"]cs_auth_role['"]\s*,/g;
let failures = 0;
let checked = 0;
let googleWriters = 0;

function fail(msg) {
  failures += 1;
  console.log(`✗ FAIL: ${msg}`);
}
function pass(msg) {
  console.log(`✓ PASS: ${msg}`);
}
function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

const pages = fs.readdirSync(REPO_ROOT).filter((f) => f.endsWith('.html')).sort();
for (const page of pages) {
  const src = fs.readFileSync(path.join(REPO_ROOT, page), 'utf8');
  if (!src.includes("'register_partner'")) continue;
  for (const m of src.matchAll(WRITE_RE)) {
    const at = m.index;
    const line = lineOf(src, at);
    const following = src.slice(at, at + 300);
    if (following.includes('signInWithGoogle(')) {
      googleWriters += 1;
      // Failed-attempt path: the catch after the redirect call must clear both keys.
      const rest = src.slice(at, at + 1500);
      const catchIdx = rest.indexOf('catch');
      const catchBody = catchIdx === -1 ? '' : rest.slice(catchIdx, catchIdx + 500);
      if (
        /removeItem\(\s*['"]cs_auth_role['"]\s*\)/.test(catchBody) &&
        /removeItem\(\s*['"]cs_auth_role_at['"]\s*\)/.test(catchBody)
      ) {
        pass(`${page}:${line} Google-redirect writer clears cs_auth_role + cs_auth_role_at in its catch`);
      } else {
        fail(`${page}:${line} Google-redirect writer does not clear cs_auth_role / cs_auth_role_at when sign-in fails`);
      }
      checked += 1;
      continue;
    }
    // Password path: must be after the register_partner RPC and after its early returns.
    const before = src.slice(0, at);
    const rpcIdx = before.lastIndexOf("'register_partner'");
    const existsIdx = before.lastIndexOf('partner_exists');
    if (rpcIdx === -1) {
      fail(`${page}:${line} cs_auth_role written with no preceding register_partner call in the file`);
      checked += 1;
      continue;
    }
    // The nearest preceding partner_exists mention (the early-return block) must itself
    // come after the RPC call, and the write must come after that block.
    if (existsIdx === -1 || existsIdx < rpcIdx) {
      fail(`${page}:${line} cs_auth_role written before the partner_exists early-return following register_partner`);
    } else {
      pass(`${page}:${line} cs_auth_role is written only after register_partner + its partner_exists early return`);
    }
    checked += 1;
  }
}

if (checked === 0) fail('discovered zero cs_auth_role writers on register_partner pages — discovery is broken');
if (googleWriters === 0) fail('discovered no Google-redirect writer (partner-insurance.html expected) — discovery is broken');
console.log(`\n${checked} writer(s) checked across ${pages.length} root html files.`);
if (failures > 0) {
  console.log(`✗ ${failures} failure(s).`);
  process.exit(1);
}
console.log('✓ All gh-2060 partner cs_auth_role ordering checks pass.');
process.exit(0);
