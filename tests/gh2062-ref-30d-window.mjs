/**
 * gh-2062 (CEO ruling, issue comment 5874597169) — the `oq-ref` attribution
 * window is 30 days FROM THE PARTNER-LINK CLICK, re-armed ONLY by a new click,
 * never by the auth advance block (success / no-op / error passes).
 *
 * Loads the REAL js/cookie-storage.js (override with SRC=<path> for the
 * negative control against the pre-fix file) into a vm context with a cookie
 * jar that honours Max-Age against a controllable clock. Nothing is mocked
 * except the browser primitives (document.cookie, Web Storage, Date.now).
 *
 * Run: node tests/gh2062-ref-30d-window.mjs   (exit 0 = pass, 1 = fail)
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = process.env.SRC || path.join(__dirname, '..', 'js', 'cookie-storage.js');
const src = fs.readFileSync(srcPath, 'utf8');
const DAY = 24 * 3600;

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function freshSandbox() {
  let nowMs = Date.UTC(2026, 8, 1);
  const jar = new Map(); // key -> { value, expiresAtMs, maxAge }
  const doc = {
    get cookie() {
      for (const [k, c] of jar) if (c.expiresAtMs <= nowMs) jar.delete(k);
      return Array.from(jar.entries()).map(([k, c]) => `${k}=${c.value}`).join('; ');
    },
    set cookie(setString) {
      const first = setString.split(';')[0];
      const eq = first.indexOf('=');
      const key = first.substring(0, eq);
      const value = first.substring(eq + 1);
      const m = /;\s*Max-Age=(-?\d+)/i.exec(setString);
      const maxAge = m ? Number(m[1]) : null;
      if (maxAge !== null && maxAge <= 0) jar.delete(key);
      else jar.set(key, { value, maxAge, expiresAtMs: maxAge === null ? Infinity : nowMs + maxAge * 1000 });
    },
  };
  const sandbox = {
    window: { location: { hostname: 'otterquote.com', protocol: 'https:' }, localStorage: makeStorage(), sessionStorage: makeStorage(), document: doc },
    document: doc,
    Date: { now: () => nowMs },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: srcPath });
  return {
    R: sandbox.window.OtterQuoteReferral,
    win: sandbox.window,
    jar,
    advanceDays: (d) => { nowMs += d * DAY * 1000; },
    maxAge: () => (jar.get('oq-ref') ? jar.get('oq-ref').maxAge : null),
    hasCookie: () => { void doc.cookie; return jar.has('oq-ref'); },
  };
}

let failed = 0;
function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failed++;
}

const A = { oq_referral_id: 'ref-A', oq_referral_agent_id: 'agent-A', oq_referral_code: 'PARTNERA' };
const B = { oq_referral_id: 'ref-B', oq_referral_agent_id: 'agent-B', oq_referral_code: 'PARTNERB' };

// 1. A partner-link click arms a 30-day cookie.
{
  const t = freshSandbox();
  t.R.write(A, { click: true });
  check(t.maxAge() === 30 * DAY, `click: Max-Age is exactly 30 days (got ${t.maxAge()}s, want ${30 * DAY}s)`);
  check(t.R.read().oq_referral_id === 'ref-A', 'click: referral still attributes to A (positive control)');
  check(t.R.read().oq_referral_ts === undefined, 'click: click timestamp is not leaked into read() results');
}

// 2. Advance-block passes (write WITHOUT click) never re-arm the clock.
{
  const t = freshSandbox();
  t.R.write(A, { click: true });
  t.advanceDays(10);
  t.R.write(A); // success pass / no-op pass / error pass all reach this same call shape
  check(t.maxAge() === 20 * DAY, `10 days after click, a non-click write leaves 20 days, not a fresh window (got ${t.maxAge()}s)`);
  t.advanceDays(19);
  t.R.write(A);
  check(t.maxAge() === 1 * DAY, `29 days after click, a non-click write leaves 1 day (got ${t.maxAge()}s)`);
  check(t.R.read().oq_referral_id === 'ref-A', 'day 29: still attributes to A inside the window (positive control)');
  t.advanceDays(2);
  check(!t.hasCookie(), 'day 31: the cookie has expired despite the advance-block writes in between');
  const r = t.R.read();
  check(Object.keys(r).length === 0, `day 31: read() returns no attribution (got ${JSON.stringify(r)})`);
  check(t.win.localStorage.getItem('oq_referral_id') === null, 'day 31: the localStorage mirror is purged too, not left as an unbounded fallback');
}

// 3. A non-click write with no click on record does not create a cookie.
{
  const t = freshSandbox();
  t.R.write(A);
  check(!t.hasCookie(), 'non-click write with no click on record does not arm a cookie');
}

// 4. A fresh click re-arms, and the last click wins.
{
  const t = freshSandbox();
  t.R.write(A, { click: true });
  t.advanceDays(20);
  t.R.write(B, { click: true });
  check(t.maxAge() === 30 * DAY, `fresh click at day 20 re-arms a full 30 days (got ${t.maxAge()}s)`);
  check(t.R.read().oq_referral_id === 'ref-B', 'fresh click: last click wins (B), attribution to A is gone');
  t.advanceDays(29);
  check(t.R.read().oq_referral_id === 'ref-B', 'day 49 (29 days after the second click): B still attributes');
}

// 5. Storage-only bound: cookie dropped (blocked / deleted), mirror must still expire.
{
  const t = freshSandbox();
  t.R.write(A, { click: true });
  t.jar.delete('oq-ref');
  t.advanceDays(31);
  check(Object.keys(t.R.read()).length === 0, 'cookie gone + 31 days: localStorage/sessionStorage fallback does not resurrect the id');
}

// 6. clear() (claim writer) still clears everything including the clock.
{
  const t = freshSandbox();
  t.R.write(A, { click: true });
  t.R.clear();
  check(!t.hasCookie() && Object.keys(t.R.read()).length === 0, 'clear(): cookie and mirrors gone');
  t.R.write(A);
  check(!t.hasCookie(), 'after clear(), a non-click write cannot resurrect a cookie');
}

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nOK: gh-2062 30-day click-anchored window proven.');
