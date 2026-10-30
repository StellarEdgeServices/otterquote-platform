/**
 * P18 - server-set partner cookie `oq_pc`. OtterQuoteReferral.read() falls back
 * to it when oq-ref is missing or expired (Safari caps script-written cookies
 * at 7 days; oq_pc is set by the /ref/<code> redirect response).
 *
 * Loads the REAL js/cookie-storage.js (override with SRC=<path> for the negative
 * control against a file without the fallback) into a vm context with a cookie
 * jar and a controllable clock.
 *
 * Run: node tests/p18-server-partner-cookie.mjs   (exit 0 = pass, 1 = fail)
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
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}

function freshSandbox() {
  let nowMs = Date.UTC(2026, 9, 1);
  const jar = new Map();
  const doc = {
    get cookie() {
      for (const [k, c] of jar) if (c.expiresAtMs <= nowMs) jar.delete(k);
      return Array.from(jar.entries()).map(([k, c]) => `${k}=${c.value}`).join('; ');
    },
    set cookie(s) {
      const first = s.split(';')[0];
      const eq = first.indexOf('=');
      const key = first.substring(0, eq);
      const m = /;\s*Max-Age=(-?\d+)/i.exec(s);
      const maxAge = m ? Number(m[1]) : null;
      if (maxAge !== null && maxAge <= 0) jar.delete(key);
      else jar.set(key, { value: first.substring(eq + 1), expiresAtMs: maxAge === null ? Infinity : nowMs + maxAge * 1000 });
    },
  };
  const sandbox = {
    window: { location: { hostname: 'otterquote.com', protocol: 'https:' }, localStorage: makeStorage(), sessionStorage: makeStorage(), document: doc },
    document: doc,
    Date: { now: () => nowMs, parse: Date.parse },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: srcPath });
  return {
    R: sandbox.window.OtterQuoteReferral,
    now: () => nowMs,
    advanceDays: (d) => { nowMs += d * DAY * 1000; },
    // What the edge function sets (the jar needs only name=value + Max-Age here).
    setPc: (code, clickMs, maxAge = 90 * DAY, raw) =>
      { doc.cookie = `oq_pc=${raw ?? encodeURIComponent(JSON.stringify({ c: code, t: new Date(clickMs).toISOString() }))}; Path=/; Max-Age=${maxAge}`; },
    dropOqRef: () => { doc.cookie = 'oq-ref=; Path=/; Max-Age=0'; sandbox.window.localStorage.removeItem('oq_referral_ts'); },
    setRaw: (k, v) => { doc.cookie = `${k}=${v}; Path=/; Max-Age=${90 * DAY}`; },
    hasPc: () => { void doc.cookie; return jar.has('oq_pc'); },
  };
}

let failed = 0;
function check(cond, label) { console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`); if (!cond) failed++; }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const A = { oq_referral_id: 'ref-A', oq_referral_agent_id: 'agent-A', oq_referral_code: 'PARTNERA' };

// 1. oq-ref absent: fall back to the oq_pc code, well past Safari's 7 days.
{
  const t = freshSandbox();
  t.setPc('PARTNERA', t.now() - 20 * DAY * 1000);
  const r = t.R.read();
  check(eq(r, { oq_referral_code: 'PARTNERA' }), `oq-ref absent, click 20 days ago: read() returns the oq_pc code (got ${JSON.stringify(r)})`);
}

// 2. Window: day 89 yes, day 91 no.
{
  const t = freshSandbox();
  t.setPc('PARTNERA', t.now() - 89 * DAY * 1000);
  check(t.R.read().oq_referral_code === 'PARTNERA', 'day 89: fallback still attributes');
  const u = freshSandbox();
  u.setPc('PARTNERA', u.now() - 91 * DAY * 1000);
  check(eq(u.R.read(), {}), 'day 91: fallback is spent');
}

// 3. oq-ref present with ids wins over oq_pc.
{
  const t = freshSandbox();
  t.R.write(A, { click: true });
  t.setPc('OTHER', t.now() - DAY * 1000);
  const r = t.R.read();
  check(r.oq_referral_id === 'ref-A' && r.oq_referral_code === 'PARTNERA', 'oq-ref with ids wins; oq_pc does not override');
}

// 4. oq-ref dropped by the browser (script cookie cap), oq_pc alive: fallback.
{
  const t = freshSandbox();
  t.R.write(A, { click: true });
  t.setPc('PARTNERA', t.now());
  t.advanceDays(10);
  t.dropOqRef();
  check(t.hasPc(), 'oq_pc (server cookie) survives day 10');
  const win = t.R;
  // sessionStorage ids are not trusted without a click stamp, so only the code remains.
  const r = win.read();
  check(r.oq_referral_code === 'PARTNERA', `day 10, oq-ref gone: read() still returns the oq_pc code (got ${JSON.stringify(r)})`);
}

// 5. Negative controls.
{
  const t = freshSandbox();
  check(eq(t.R.read(), {}), 'no cookies at all: read() returns nothing');
  for (const [label, raw] of [
    ['not JSON', 'garbage'],
    ['no code', encodeURIComponent(JSON.stringify({ t: new Date(t.now()).toISOString() }))],
    ['bad time', encodeURIComponent(JSON.stringify({ c: 'X', t: 'yesterday' }))],
  ]) {
    const u = freshSandbox();
    u.setPc('', u.now(), 90 * DAY, raw);
    check(eq(u.R.read(), {}), `malformed oq_pc (${label}) is ignored`);
  }
}

// 6. clear() removes oq_pc so consumed attribution does not return.
{
  const t = freshSandbox();
  t.setPc('PARTNERA', t.now());
  check(t.R.read().oq_referral_code === 'PARTNERA', 'before clear: code present');
  t.R.clear();
  check(!t.hasPc() && eq(t.R.read(), {}), 'after clear(): oq_pc is gone and read() returns nothing');
}

// 7. Last click wins between oq-ref and oq_pc.
{
  // older A in oq-ref + newer B in oq_pc => B, stale A ids gone
  const t = freshSandbox();
  t.R.write(A, { click: true });
  t.advanceDays(3);
  t.setPc('PARTNERB', t.now());
  const r = t.R.read();
  check(eq(r, { oq_referral_code: 'PARTNERB' }), `older A + newer B: B wins and A's ids are not returned (got ${JSON.stringify(r)})`);
  check(eq(t.R.read(), { oq_referral_code: 'PARTNERB' }), 'older A + newer B: stable on re-read');
}
{
  // newer A + older B => A
  const t = freshSandbox();
  t.setPc('PARTNERB', t.now() - 5 * DAY * 1000);
  t.R.write(A, { click: true });
  const r = t.R.read();
  check(r.oq_referral_id === 'ref-A' && r.oq_referral_code === 'PARTNERA', `newer A + older B: A wins (got ${JSON.stringify(r)})`);
}
{
  // same partner, newer oq_pc => keep oq-ref ids
  const t = freshSandbox();
  t.R.write(A, { click: true });
  t.advanceDays(1);
  t.setPc('PARTNERA', t.now());
  check(t.R.read().oq_referral_id === 'ref-A', 'same partner, newer oq_pc: oq-ref ids kept');
}
{
  // oq-ref with no click time (legacy) => in-window oq_pc wins
  const t = freshSandbox();
  t.setRaw('oq-ref', encodeURIComponent(JSON.stringify(A)));
  t.setPc('PARTNERB', t.now() - DAY * 1000);
  check(eq(t.R.read(), { oq_referral_code: 'PARTNERB' }), 'legacy oq-ref (no click time): in-window oq_pc wins');
}
{
  // negative control: oq_pc outside the window => oq-ref returned
  const t = freshSandbox();
  t.R.write(A, { click: true });
  t.setPc('PARTNERB', t.now() - 91 * DAY * 1000);
  check(t.R.read().oq_referral_id === 'ref-A', 'oq_pc outside the 90-day window is ignored; oq-ref returned');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
