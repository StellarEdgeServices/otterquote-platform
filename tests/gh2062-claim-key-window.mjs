/**
 * gh-2062 (REVIEW: FAIL 5881363760 / RETURNED 5881780522, must-fix 1) - the
 * claim-scoped copy `oq_referral_id_for_claim` lives under the SAME 30-day
 * click clock as the `oq-ref` cookie. Advance at day 0 with no claim; the claim
 * writer at day 31 must get NO referral id. Undated `_for_claim` expires.
 *
 * Runs the REAL code, not a re-implementation:
 *   - js/cookie-storage.js in a vm sandbox (cookie jar honours Max-Age vs a
 *     controllable clock);
 *   - the advance block extracted verbatim from js/auth.js;
 *   - the claim-writer id chain extracted verbatim from trade-selector.html.
 * Override ROOT=<dir holding js/ and trade-selector.html> for the negative
 * control against the pre-fix files.
 *
 * Run: node tests/gh2062-claim-key-window.mjs   (exit 0 = pass, 1 = fail)
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT || path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const cookieSrc = read('js/cookie-storage.js');
const authSrc = read('js/auth.js');
const tsSrc = read('trade-selector.html');
const DAY = 24 * 3600;
const CLAIM = 'oq_referral_id_for_claim';

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
  const jar = new Map();
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
  vm.runInContext(cookieSrc, sandbox, { filename: 'js/cookie-storage.js' });
  return {
    R: sandbox.window.OtterQuoteReferral,
    win: sandbox.window,
    ls: sandbox.window.localStorage,
    ss: sandbox.window.sessionStorage,
    jar,
    sandbox,
    advanceDays: (d) => { nowMs += d * DAY * 1000; },
  };
}

function extractBetween(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error('marker not found: ' + startMarker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(a, b + endMarker.length);
}

// The auth.js advance block, verbatim.
const advanceBlock = extractBetween(
  authSrc,
  'const referralId = (window.OtterQuoteReferral',
  "console.error('Error advancing referral status:', err);\n      }\n    }",
);
async function runAdvance(t) {
  const calls = [];
  const sb = { rpc: async (name, args) => { calls.push({ name, args }); return { error: null }; } };
  const fn = new vm.Script(`(async function (window, localStorage, sessionStorage, sb, console) { ${advanceBlock} })`).runInContext(t.sandbox);
  await fn(t.win, t.ls, t.ss, sb, console);
  return calls;
}

// The trade-selector.html claim-writer id chain, verbatim.
const chainBlock = extractBetween(
  tsSrc,
  'const refCookie = window.OtterQuoteReferral',
  'const chainReferralAgentId',
).replace(/const chainReferralAgentId$/, '');
function claimWriterReferralId(t) {
  const fn = new vm.Script(`(function (window, localStorage, sessionStorage) { ${chainBlock} return chainReferralId; })`).runInContext(t.sandbox);
  return fn(t.win, t.ls, t.ss);
}

let failed = 0;
function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failed++;
}
const A = { oq_referral_id: 'ref-A', oq_referral_agent_id: 'agent-A', oq_referral_code: 'PARTNERA' };

// 1. THE BUG: advance at day 0, no claim, claim writer at day 31 -> NO id.
{
  const t = freshSandbox();
  t.R.write(A, { click: true });
  const calls = await runAdvance(t);
  check(calls.length === 1 && calls[0].args.p_referral_id === 'ref-A', 'day 0: advance RPC fires for ref-A');
  check(t.ls.getItem(CLAIM) === 'ref-A', 'day 0: advance re-keys the id to the claim-scoped key');
  t.advanceDays(31);
  const got = claimWriterReferralId(t);
  check(got === null, `day 31: claim writer gets NO referral id (got ${JSON.stringify(got)})`);
  check(t.ls.getItem(CLAIM) === null, 'day 31: the claim-scoped key is purged, not left as an immortal fallback');
}

// 2. POSITIVE CONTROL: in-window the claim-scoped id still attributes.
{
  const t = freshSandbox();
  t.R.write(A, { click: true });
  await runAdvance(t);
  t.advanceDays(29);
  check(claimWriterReferralId(t) === 'ref-A', 'day 29: claim writer still gets ref-A (positive control)');
  check(t.R.read()[CLAIM] === 'ref-A', 'day 29: read() returns the in-window claim-scoped id');
}

// 2b. Isolate the claim-scoped path: cookie and id mirrors gone, click ts kept.
{
  const t = freshSandbox();
  t.R.write(A, { click: true });
  await runAdvance(t);
  t.jar.delete('oq-ref');
  for (const k of Object.keys(A)) { t.ls.removeItem(k); t.ss.removeItem(k); }
  t.advanceDays(29);
  check(claimWriterReferralId(t) === 'ref-A', 'day 29, cookie+mirrors gone: only the claim-scoped key attributes (positive control)');
  t.advanceDays(2);
  check(claimWriterReferralId(t) === null, 'day 31, cookie+mirrors gone: the claim-scoped key no longer attributes');
}

// 3. Undated claim-scoped id (no click ts on record anywhere) is expired.
{
  const t = freshSandbox();
  t.ls.setItem(CLAIM, 'ref-stale');
  check(claimWriterReferralId(t) === null, 'undated _for_claim: claim writer gets NO referral id');
  check(t.ls.getItem(CLAIM) === null, 'undated _for_claim: purged');
}

// 4. writeClaimId with no click on record writes nothing.
{
  const t = freshSandbox();
  check(typeof t.R.writeClaimId === 'function', 'writeClaimId exists');
  if (typeof t.R.writeClaimId === 'function') {
    t.R.writeClaimId('ref-X');
    check(t.ls.getItem(CLAIM) === null, 'no click on record: writeClaimId writes nothing');
  }
}

// 5. clear() purges the claim-scoped key.
{
  const t = freshSandbox();
  t.R.write(A, { click: true });
  await runAdvance(t);
  t.R.clear();
  check(t.ls.getItem(CLAIM) === null, 'clear(): claim-scoped key removed');
}

// 6. Expired app-origin mirror (no cookie): advance block does not advance nor set _for_claim.
{
  const t = freshSandbox();
  t.ls.setItem('oq_referral_id', 'ref-stale');
  t.ls.setItem('oq_referral_ts', String(Date.UTC(2026, 8, 1) - 31 * DAY * 1000));
  const calls = await runAdvance(t);
  check(calls.length === 0, `expired mirror: advance RPC not called (calls=${calls.length})`);
  check(t.ls.getItem(CLAIM) === null, 'expired mirror: _for_claim not set');
}
// 6b. Undated app-origin mirror.
{
  const t = freshSandbox();
  t.ls.setItem('oq_referral_id', 'ref-stale');
  const calls = await runAdvance(t);
  check(calls.length === 0, `undated mirror: advance RPC not called (calls=${calls.length})`);
  check(t.ls.getItem(CLAIM) === null, 'undated mirror: _for_claim not set');
}

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nOK: gh-2062 claim-scoped id rides the 30-day click clock.');
