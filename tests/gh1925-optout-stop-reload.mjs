/**
 * gh-1925 stop-and-reload (Ben 6029316903, spec 6025412221) -- pressing the section 12 opt-out button must (a) stop the GA4 and
 * Clarity tags that are ALREADY loaded on the page, and (b) reload the page once so every gate re-reads the cookie. Before this the
 * press wrote the cookie and nothing else: tags already running kept running until the next navigation.
 * Runs the REAL inline script of privacy.html in vm. Env PRIVACY_FILE overrides the file under test (negative control: origin/main).
 * Run: node tests/gh1925-optout-stop-reload.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.PRIVACY_FILE || path.join(ROOT, 'privacy.html');
const html = fs.readFileSync(file, 'utf8');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

const UID = '0b9d2f3e-1a2b-4c3d-8e9f-a1b2c3d4e5f6';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const AT = 'sb-otterquote-at=' + encodeURIComponent('h.' + b64u({ sub: UID }) + '.s');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.includes('oq-ad-optout-btn'));
ok(scripts.length === 1, 'privacy.html has exactly one inline script wiring the section 12 button');

function run({ jar = '', withClarity = true, fetchImpl } = {}) {
  const log = []; const timers = []; let listener = null;
  const btn = { disabled: false, addEventListener(t, fn) { if (t === 'click') listener = fn; } };
  const document = { get cookie() { return jar; }, set cookie(v) { log.push('cookie'); }, getElementById: (id) => (id === 'oq-ad-optout-btn' ? btn : null) };
  const win = { location: { hostname: 'otterquote.com', reload: () => log.push('reload') } };
  if (withClarity) win.clarity = (...a) => log.push('clarity:' + a.join(','));
  const ctx = { window: win, document, navigator: {}, CONFIG: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON: 'k' }, fetch: (u, o) => { log.push('patch'); return fetchImpl(u, o); },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'), decodeURIComponent, encodeURIComponent, JSON, String, Date, RegExp, Promise, console: { warn() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } };
  vm.createContext(ctx); vm.runInContext(scripts[0] || '', ctx);
  return { btn, win, log, timers, click: () => listener && listener() };
}
const tick = () => new Promise((r) => setTimeout(r, 20));
const count = (a, x) => a.filter((e) => e === x).length;

// 1. signed out: tags stopped, cookie first, one reload
{
  const r = run(); r.click(); await tick();
  ok(r.win['ga-disable-G-D1Y1TLGEFY'] === true, 'signed out: window["ga-disable-G-D1Y1TLGEFY"] is set (GA4 stops sending)');
  ok(count(r.log, 'clarity:stop') === 1, 'signed out: clarity("stop") is called once');
  ok(count(r.log, 'reload') === 1, 'signed out: the page reloads exactly once (got ' + count(r.log, 'reload') + ')');
  ok(r.log.indexOf('cookie') !== -1 && r.log.indexOf('cookie') < r.log.indexOf('reload'), 'signed out: the cookie is written before the reload');
  ok(r.btn.disabled === true, 'signed out: button disabled');
}
// 2. no Clarity on the page: no throw, still reloads
{
  let threw = false; const r = run({ withClarity: false });
  try { r.click(); } catch (e) { threw = true; } await tick();
  ok(!threw && count(r.log, 'reload') === 1 && r.win['ga-disable-G-D1Y1TLGEFY'] === true, 'no Clarity: no throw, GA4 flag set, one reload');
}
// 3. signed in: the reload waits for the profile PATCH to settle
{
  let release; const r = run({ jar: AT, fetchImpl: () => new Promise((res) => { release = () => res({ ok: true }); }) });
  r.click(); await tick();
  ok(count(r.log, 'patch') === 1 && count(r.log, 'reload') === 0, 'signed in: PATCH sent, NO reload while the PATCH is pending (a reload would cancel it)');
  release(); await tick();
  ok(count(r.log, 'reload') === 1 && r.log.indexOf('patch') < r.log.indexOf('reload'), 'signed in: one reload after the PATCH settles');
  r.timers.forEach((t) => t.fn());
  ok(count(r.log, 'reload') === 1, 'signed in: the 1.5 s cap firing afterwards does not reload a second time');
}
// 4. signed in, PATCH never settles: the cap reloads anyway, at 1500 ms
{
  const r = run({ jar: AT, fetchImpl: () => new Promise(() => {}) });
  r.click(); await tick();
  ok(count(r.log, 'reload') === 0 && r.timers.some((t) => t.ms === 1500), 'hung PATCH: not reloaded yet, a 1500 ms cap timer is armed');
  r.timers.forEach((t) => t.fn());
  ok(count(r.log, 'reload') === 1, 'hung PATCH: the cap reloads the page once');
}
// 5. PATCH rejects: still reloads once
{
  const r = run({ jar: AT, fetchImpl: () => Promise.reject(new Error('net')) });
  r.click(); await tick();
  ok(count(r.log, 'reload') === 1 && r.win['ga-disable-G-D1Y1TLGEFY'] === true, 'PATCH rejects: tags stopped and one reload');
}
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
