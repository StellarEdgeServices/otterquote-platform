/**
 * P18 (#3219) - js/cookie-storage.js: the 90-day window constant and OtterQuoteReferral.adoptLocked() (credit lock, browser side),
 * plus a static check that js/auth.js asks the database which referral is locked right after advance_referral_registered.
 * Loads the REAL js/cookie-storage.js (SRC=<path> overrides) in a vm with a Max-Age-honouring cookie jar and a controllable clock.
 * Run: node tests/p18-credit-lock-adopt.mjs   (exit 0 = pass)
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = process.env.SRC || path.join(__dirname, '..', 'js', 'cookie-storage.js');
const src = fs.readFileSync(srcPath, 'utf8');
const DAY = 24 * 3600;

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };
function sandbox() {
  let nowMs = Date.UTC(2026, 9, 1);
  const jar = new Map();
  const doc = {
    get cookie() { for (const [k, c] of jar) if (c.expiresAtMs <= nowMs) jar.delete(k); return Array.from(jar.entries()).map(([k, c]) => `${k}=${c.value}`).join('; '); },
    set cookie(s) {
      const first = s.split(';')[0]; const eq = first.indexOf('=');
      const key = first.substring(0, eq); const value = first.substring(eq + 1);
      const m = /;\s*Max-Age=(-?\d+)/i.exec(s); const maxAge = m ? Number(m[1]) : null;
      if (maxAge !== null && maxAge <= 0) jar.delete(key); else jar.set(key, { value, maxAge, expiresAtMs: maxAge === null ? Infinity : nowMs + maxAge * 1000 });
    },
  };
  const sb = { window: { location: { hostname: 'otterquote.com', protocol: 'https:' }, localStorage: store(), sessionStorage: store(), document: doc }, document: doc, Date: { now: () => nowMs }, console };
  vm.createContext(sb); vm.runInContext(src, sb, { filename: srcPath });
  return { R: sb.window.OtterQuoteReferral, win: sb.window, jar, advanceDays: (d) => { nowMs += d * DAY * 1000; }, maxAge: () => (jar.get('oq-ref') ? jar.get('oq-ref').maxAge : null) };
}

let failed = 0;
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`); if (!cond) failed++; };
const A = { oq_referral_id: 'ref-A', oq_referral_agent_id: 'agent-A', oq_referral_code: 'PARTNERA' };
const B = { oq_referral_id: 'ref-B', oq_referral_agent_id: 'agent-B', oq_referral_code: 'PARTNERB' };

// 1. one shared constant: 90 days
{
  const t = sandbox();
  check(t.R._MAX_AGE === 90 * DAY, `the window constant is 90 days (got ${t.R._MAX_AGE}s)`);
  t.R.write(A, { click: true });
  check(t.maxAge() === 90 * DAY, `a click arms Max-Age 90 days (got ${t.maxAge()}s)`);
}
// 2. A locked, B clicked later: the cookie goes back to A, B's agent/code are dropped
{
  const t = sandbox();
  t.R.write(B, { click: true });
  const changed = t.R.adoptLocked('ref-A');
  const r = t.R.read();
  check(changed === true, 'adoptLocked returns true when it replaced the id');
  check(r.oq_referral_id === 'ref-A' && r.oq_referral_agent_id === undefined && r.oq_referral_code === undefined, `cookie holds only A's id (got ${JSON.stringify(r)})`);
  check(r.oq_referral_id_for_claim === 'ref-A', 'the claim-scoped key is A');
  check(t.win.localStorage.getItem('oq_referral_agent_id') === null, "B's agent id is not left in localStorage");
}
// 3. the click clock is kept (no re-arm)
{
  const t = sandbox();
  t.R.write(B, { click: true });
  t.advanceDays(40);
  t.R.adoptLocked('ref-A');
  check(t.maxAge() === 50 * DAY, `Max-Age after the swap is the time remaining, 50 days (got ${t.maxAge()}s)`);
  t.advanceDays(49);
  check(t.R.read().oq_referral_id === 'ref-A', 'day 89: still attributes');
  t.advanceDays(2);
  check(Object.keys(t.R.read()).length === 0, 'day 91: expired, nothing attributes');
}
// 4. controls: same id, no lock, bad input, no cookie, undated
{
  const t = sandbox();
  t.R.write(A, { click: true });
  check(t.R.adoptLocked('ref-A') === false && t.R.read().oq_referral_agent_id === 'agent-A', 'same id: unchanged, agent kept');
  let allFalse = true;
  for (const v of [null, undefined, true, 7, {}, '']) if (t.R.adoptLocked(v) !== false) allFalse = false;
  check(allFalse && t.R.read().oq_referral_id === 'ref-A', 'no lock / bad input: cookie untouched');
  const e = sandbox();
  check(e.R.adoptLocked('ref-A') === false && Object.keys(e.R.read()).length === 0 && e.win.localStorage.getItem('oq_referral_id') === null, 'no cookie on record: nothing written');
  const u = sandbox();
  u.win.localStorage.setItem('oq_referral_id', 'ref-B');
  check(u.R.adoptLocked('ref-A') === false && Object.keys(u.R.read()).length === 0, 'undated id: expired, nothing to swap, nothing written');
  const o = sandbox();
  o.R.write(B, { click: true }); o.advanceDays(91);
  check(o.R.adoptLocked('ref-A') === false && Object.keys(o.R.read()).length === 0, 'a click 91 days old: nothing to swap');
}
// 5. js/auth.js asks the database right after the advance
{
  const auth = fs.readFileSync(path.join(__dirname, '..', 'js', 'auth.js'), 'utf8');
  const i = auth.indexOf("rpc('advance_referral_registered'");
  const j = auth.indexOf("rpc('get_locked_referral_id')", i);
  check(i > 0 && j > i && j - i < 3000, 'js/auth.js calls get_locked_referral_id after advance_referral_registered');
  check(/adoptLocked\(/.test(auth.slice(j, j + 400)), 'js/auth.js hands the answer to OtterQuoteReferral.adoptLocked');
}

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nOK: P18 90-day constant and credit-lock adopt proven (browser side).');
