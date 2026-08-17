/**
 * Regression test for gh-867 — js/cookie-storage.js getCookieMaxAge() 7-day
 * hard cap on the session cookie.
 *
 * Root cause: getCookieMaxAge(expSec) computed
 *   `Math.max(3600, Math.max(remaining, defaultSec))`
 * where `remaining` is the time left on the JWT — always ~3600 (1h access
 * token). So `Math.max(remaining, defaultSec)` was always `defaultSec`, and
 * the outer `Math.max(3600, …)` never bound. The function returned exactly
 * `defaultSec` (previously 604800 — a hard 7 days) on every call, with no
 * branch producing any other value. Verified live against Supabase: 0 of
 * 26,396 session rows carry a not_after value (no backend session time-box)
 * and refresh-token rotation is healthy well past a week — the 7-day cap
 * was entirely self-imposed, forcing weekly magic-link re-authentication.
 *
 * `defaultSec` is now 400 days (34,560,000s) — Chrome's Max-Age ceiling.
 * This test loads the real js/cookie-storage.js source into a minimal vm
 * context and asserts the exposed `_getCookieMaxAge` test hook returns the
 * new value, including for the always-hit ~1h-remaining case the bug
 * describes.
 *
 * Run: node tests/cookie-max-age-400-days.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'cookie-storage.js'), 'utf8');

const FOUR_HUNDRED_DAYS_SEC = 400 * 24 * 3600;
const SEVEN_DAYS_SEC = 7 * 24 * 3600;
const NOW = Math.floor(Date.now() / 1000);

const sandbox = {
  window: {
    location: { hostname: 'app.otterquote.com', protocol: 'https:' },
  },
  document: { cookie: '' },
  console,
};
sandbox.window.document = sandbox.document;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'js/cookie-storage.js' });

const getMaxAge = sandbox.window.OtterQuoteCookieStorage && sandbox.window.OtterQuoteCookieStorage._getCookieMaxAge;

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.log(`✗ FAIL: ${label} — expected ${expected}, got ${actual}`);
    process.exit(1);
  }
  console.log(`✓ PASS: ${label} (${actual})`);
}

function main() {
  if (typeof getMaxAge !== 'function') {
    console.log('✗ FAIL: window.OtterQuoteCookieStorage._getCookieMaxAge test hook not found.');
    process.exit(1);
  }

  assertEqual(getMaxAge(null), FOUR_HUNDRED_DAYS_SEC, 'no expSec -> 400 days (not the old 7-day default)');

  // The exact regression the issue describes: a fresh 1h access token means
  // `remaining` is ~3600s, which must NOT shrink the max-age back toward 7 days.
  const withTypicalAccessToken = getMaxAge(NOW + 3600);
  assertEqual(withTypicalAccessToken, FOUR_HUNDRED_DAYS_SEC, '~1h remaining (typical access token) -> 400 days');
  if (withTypicalAccessToken <= SEVEN_DAYS_SEC) {
    console.log('✗ FAIL: max-age did not clear the old 7-day cap.');
    process.exit(1);
  }

  assertEqual(getMaxAge(NOW - 3600), FOUR_HUNDRED_DAYS_SEC, 'already-expired token -> still 400 days');

  console.log('✓ PASS: getCookieMaxAge() returns 400 days (34560000s), never the old 604800s (7-day) default.');
  process.exit(0);
}

main();
