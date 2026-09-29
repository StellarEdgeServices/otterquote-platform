/**
 * gh-2346 (money, D-301 referral attribution) - sessionStorage is PER TAB but
 * there is ONE click clock (oq_referral_ts: cookie + localStorage). A newer
 * click in another tab must not make an older tab's sessionStorage ids look
 * in-window. Also: a fresh click write must clear keys it does not carry.
 *
 * Loads the REAL js/cookie-storage.js (override with SRC=<path> for the
 * negative control against #2321's head b9ea03c7) into one vm context PER TAB:
 * the tabs share localStorage and the clock, and each has its own
 * sessionStorage. Cookies are OFF (the document.cookie setter is a no-op), the
 * hard case in the issue.
 *
 * Run: node tests/gh2346-session-tab-clock.mjs   (exit 0 = pass, 1 = fail)
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = process.env.SRC || path.join(__dirname, '..', 'js', 'cookie-storage.js');
const src = fs.readFileSync(srcPath, 'utf8');
const DAY = 24 * 3600 * 1000;

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// One browser: shared localStorage + clock (+ optional shared cookie jar).
function browser({ cookies = false } = {}) {
  const shared = { now: Date.UTC(2026, 8, 1), local: makeStorage(), jar: new Map() };
  function tab() {
    const doc = {
      get cookie() { return cookies ? Array.from(shared.jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ') : ''; },
      set cookie(s) {
        if (!cookies) return;
        const first = s.split(';')[0];
        const eq = first.indexOf('=');
        const m = /;\s*Max-Age=(-?\d+)/i.exec(s);
        if (m && Number(m[1]) <= 0) shared.jar.delete(first.substring(0, eq));
        else shared.jar.set(first.substring(0, eq), first.substring(eq + 1));
      },
    };
    const sandbox = {
      window: { location: { hostname: 'otterquote.com', protocol: 'https:' }, localStorage: shared.local, sessionStorage: makeStorage(), document: doc },
      document: doc,
      Date: { now: () => shared.now },
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: srcPath });
    const win = sandbox.window;
    return {
      R: win.OtterQuoteReferral,
      win,
      // What trade-selector.html does at claim time: windowed reader FIRST,
      // then the RAW sessionStorage / localStorage fallbacks.
      claimId() {
        const r = win.OtterQuoteReferral.read();
        return r.oq_referral_id || win.sessionStorage.getItem('oq_referral_id') || win.localStorage.getItem('oq_referral_id') || r.oq_referral_id_for_claim || null;
      },
      claimAgent() {
        const r = win.OtterQuoteReferral.read();
        return r.oq_referral_agent_id || win.sessionStorage.getItem('oq_referral_agent_id') || win.localStorage.getItem('oq_referral_agent_id') || null;
      },
    };
  }
  return { tab, advanceDays: (d) => { shared.now += d * DAY; }, shared };
}

let failed = 0;
function check(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failed++;
}

const A = { oq_referral_id: 'ref-A', oq_referral_agent_id: 'agent-A', oq_referral_code: 'PARTNERA' };
const B = { oq_referral_id: 'ref-B', oq_referral_agent_id: 'agent-B', oq_referral_code: 'PARTNERB' };

// 1. THE TWO-TAB REPRO (issue #2346). Tab 1 clicks A on day 0; tab 2 clicks B on
//    day 40; the homeowner files from tab 1. Correct result: B (or nothing) - never A.
{
  const b = browser();
  const t1 = b.tab(), t2 = b.tab();
  t1.R.write(A, { click: true });
  b.advanceDays(40);
  t2.R.write(B, { click: true });
  const got = t1.claimId();
  const gotAgent = t1.claimAgent();
  console.log(`  (info) tab-1 claim at day 40 yields id=${got} agent=${gotAgent}`);
  check(got !== 'ref-A', 'two-tab: the claim from tab 1 does NOT yield A');
  check(got === 'ref-B', 'two-tab: the claim from tab 1 yields B (the newer click)');
  check(gotAgent !== 'agent-A', "two-tab: tab 1 does not yield A's agent either");
  check(t1.win.sessionStorage.getItem('oq_referral_id') === null, "two-tab: tab 1's stale sessionStorage id is purged, so raw fallbacks see nothing");
  check(t2.claimId() === 'ref-B', 'two-tab: tab 2 (the newer click) still attributes to B');
}

// 1b. Same repro, cookies ON (cookie carries B; session must still not win anywhere).
{
  const b = browser({ cookies: true });
  const t1 = b.tab(), t2 = b.tab();
  t1.R.write(A, { click: true });
  b.advanceDays(40);
  t2.R.write(B, { click: true });
  check(t1.claimId() === 'ref-B', 'two-tab, cookies on: the claim from tab 1 yields B');
}

// 2. POSITIVE CONTROL: same tab, in window, still attributes - through read() and
//    through the raw sessionStorage fallback the claim writers keep.
{
  const b = browser();
  const t1 = b.tab();
  t1.R.write(A, { click: true });
  b.advanceDays(10);
  check(t1.claimId() === 'ref-A' && t1.claimAgent() === 'agent-A', 'same-tab in-window (day 10): still attributes to A');
  check(t1.R.read().oq_referral_id === 'ref-A', 'same-tab in-window: read() returns A');
  check(t1.win.sessionStorage.getItem('oq_referral_id') === 'ref-A', "same-tab in-window: this tab's own ids are NOT purged");
  b.advanceDays(19); // day 29
  check(t1.claimId() === 'ref-A', 'same-tab day 29: still attributes to A');
  // a non-click advance-block write in the same tab keeps the stamp equal to the clock
  t1.R.write({ oq_referral_id: 'ref-A', oq_referral_agent_id: 'agent-A', oq_referral_code: 'PARTNERA' });
  check(t1.claimId() === 'ref-A', 'same-tab: an advance-block (non-click) write keeps attributing to A');
}

// 3. Unstamped sessionStorage ids (a tab opened before this fix, or a raw write)
//    are not trusted, even in-window; localStorage (the clock's own mirror) is.
{
  const b = browser();
  const t1 = b.tab();
  t1.R.write(B, { click: true });
  t1.win.sessionStorage.removeItem('oq_referral_ts');
  t1.win.sessionStorage.setItem('oq_referral_id', 'ref-STALE');
  check(t1.claimId() === 'ref-B', 'unstamped session id is dropped; claim yields B from localStorage');
}

// 4. A stamp older than 30 days is not trusted.
{
  const b = browser();
  const t1 = b.tab();
  t1.R.write(A, { click: true });
  t1.win.sessionStorage.setItem('oq_referral_ts', String(b.shared.now - 31 * DAY));
  t1.R.read();
  check(t1.win.sessionStorage.getItem('oq_referral_id') === null, 'stamp > 30 days old: session ids purged');
}

// 5. CLICK WRITE CLEARS ABSENT KEYS: partner A's agent/code must not pair with
//    partner B's id.
{
  const b = browser();
  const t1 = b.tab();
  t1.R.write(A, { click: true });
  t1.R.write({ oq_referral_id: 'ref-B' }, { click: true }); // B's click carries no agent/code
  check(t1.win.localStorage.getItem('oq_referral_agent_id') === null, "click write: A's agent id is gone from localStorage");
  check(t1.win.localStorage.getItem('oq_referral_code') === null, "click write: A's code is gone from localStorage");
  check(t1.win.sessionStorage.getItem('oq_referral_agent_id') === null && t1.win.sessionStorage.getItem('oq_referral_code') === null, "click write: A's agent/code are gone from sessionStorage");
  const r = t1.R.read();
  check(r.oq_referral_id === 'ref-B' && r.oq_referral_agent_id === undefined && r.oq_referral_code === undefined, "click write: read() returns B's id with no leftover agent/code");
  check(t1.claimAgent() === null, "click write: the claim writer's agent id fallback sees nothing");
}
// 5b. same with cookies on (cookie is already fully overwritten; storage must match).
{
  const b = browser({ cookies: true });
  const t1 = b.tab();
  t1.R.write(A, { click: true });
  t1.R.write({ oq_referral_id: 'ref-B' }, { click: true });
  const r = t1.R.read();
  check(r.oq_referral_id === 'ref-B' && r.oq_referral_agent_id === undefined && t1.win.localStorage.getItem('oq_referral_agent_id') === null, 'click write, cookies on: no leftover A agent in read() or localStorage');
}

// 6. clear() also drops the tab's stamp.
{
  const b = browser();
  const t1 = b.tab();
  t1.R.write(A, { click: true });
  t1.R.clear();
  check(t1.win.sessionStorage.getItem('oq_referral_ts') === null, 'clear(): the sessionStorage stamp is removed');
}

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nOK: gh-2346 per-tab click stamp + absent-key clearing proven.');
