/**
 * gh-1925 / D-354 -- Dustin's ruling on #1925 (comment 5973764305): "Yes, gate Clarity (Recommended)". Microsoft Clarity is treated as
 * a "share" for the Do Not Sell or Share opt-out. Three behaviours of the REAL js/ga-gate.js, each with its control beside it:
 *
 *   A. Clarity does not load for a visitor with the oq_ad_optout cookie or Global Privacy Control (it loads without them).
 *   B. The GA4 library AND Clarity read the signed-in account's stored profiles.ad_sharing_opt_out before loading: `true` or an
 *      unreadable flag loads neither; a definite `false`, or no session at all, loads both. One read per page load.
 *   C. /auth-callback never requests the GA4 library (CEO, #2304 comment 5974043923 item 7), in any state; other pages do.
 *
 * Runs the real file in a vm context with a fake window, document, navigator, cookie jar, CONFIG and fetch. Nothing is mocked inside
 * the gate itself. GATE_FILE overrides the file under test, which is how the negative control is run against main's copy:
 *   git show origin/main:js/ga-gate.js > /tmp/ga-gate.main.js && GATE_FILE=/tmp/ga-gate.main.js node tests/gh1925-clarity-ga4-stored-flag.mjs
 * (expected: FAIL lines for A, B and C, exit 1).
 *
 * Run: node tests/gh1925-clarity-ga4-stored-flag.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.GATE_FILE || path.join(HERE, '..', 'js', 'ga-gate.js');
const src = fs.readFileSync(file, 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

const UID = '0b9d2f3e-1a2b-4c3d-8e9f-a1b2c3d4e5f6';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const TOKEN = 'h.' + b64u({ sub: UID }) + '.s';
const SESSION = 'sb-otterquote-at=' + encodeURIComponent(TOKEN);
const CFG = { SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_ANON: 'anon-key' };

/**
 * Executes the gate for one page load and waits for it to settle. `fetchImpl` answers the stored-flag read; `cfg: null` models a page
 * that never loads js/config.js (the gate's 5 s wait is run on a fast clock: setTimeout delays are divided by 100).
 */
async function load({ host = 'otterquote.com', pathname = '/', gpc, cookie = '', cfg = CFG, fetchImpl } = {}) {
  const appended = [];
  const cookieWrites = [];
  const fetchCalls = [];
  let jar = cookie;
  const doc = {
    get cookie() { return jar; },
    set cookie(v) { cookieWrites.push(v); const [kv] = v.split(';'); const [k] = kv.split('='); const rest = jar.split('; ').filter((c) => c && !c.startsWith(k + '=')); rest.push(kv); jar = rest.join('; '); },
    createElement: (tag) => ({ tag }),
    head: { appendChild: (el) => appended.push(el) },
    documentElement: {},
    addEventListener() {}, removeEventListener() {},
    getElementsByTagName: () => [{ parentNode: { insertBefore: (el) => appended.push(el) } }],
  };
  const win = {
    location: { hostname: host, hash: '', search: '', pathname },
    addEventListener() {}, removeEventListener() {},
    requestIdleCallback: (fn) => { fn(); return 1; }, // run the idle load immediately
    cancelIdleCallback() {},
  };
  function FakeMutationObserver() { return { observe() {} }; }
  const ctx = {
    window: win, document: doc, navigator: gpc === undefined ? {} : { globalPrivacyControl: gpc },
    URLSearchParams, decodeURIComponent, encodeURIComponent, JSON, String, Array, Promise,
    setTimeout: (fn, ms) => setTimeout(fn, Math.ceil((ms || 0) / 100)), clearTimeout,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    MutationObserver: FakeMutationObserver,
    fetch: (url, opts) => { fetchCalls.push({ url: String(url), opts }); return (fetchImpl || (() => Promise.reject(new Error('no fetchImpl'))))(url, opts); },
  };
  if (cfg) ctx.CONFIG = cfg;
  win.window = win;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  await new Promise((r) => setTimeout(r, 120)); // > the scaled 5 s CONFIG wait (50 ms) and any promise chain
  const count = (sub) => appended.filter((e) => e.tag === 'script' && String(e.src).indexOf(sub) !== -1).length;
  return { ga4: count('googletagmanager.com/gtag/js'), clarity: count('clarity.ms/tag/'), cookieWrites, fetchCalls, gtag: win.gtag, win };
}
const rows = (flag) => () => Promise.resolve({ ok: true, json: () => Promise.resolve([{ ad_sharing_opt_out: flag }]) });
const wroteOptOut = (r) => r.cookieWrites.some((w) => w.startsWith('oq_ad_optout=1'));

// ---------------------------------------------------------------------------------------------------------------------
// A. Clarity and the synchronous signals (cookie, Global Privacy Control)
// ---------------------------------------------------------------------------------------------------------------------
{
  const c = await load({});
  ok(c.clarity === 1 && c.ga4 === 1, 'A CONTROL: no opt-out, no GPC, no session on / -> Clarity and GA4 each load exactly once (clarity ' + c.clarity + ', ga4 ' + c.ga4 + ')');
  ok(c.fetchCalls.length === 0, 'A CONTROL: a signed-out visitor makes no profile read');

  const g = await load({ gpc: true });
  ok(g.clarity === 0, 'A: Global Privacy Control on -> the Clarity tag is NOT requested (got ' + g.clarity + ')');
  ok(g.ga4 === 0, 'A: Global Privacy Control on -> the GA4 library is NOT requested');
  ok(wroteOptOut(g), 'A: Global Privacy Control on -> the shared oq_ad_optout cookie is left behind');
  ok(typeof g.win.clarity === 'undefined', 'A: Global Privacy Control on -> window.clarity is never defined (no stub queue either)');

  const k = await load({ cookie: 'oq_ad_optout=1' });
  ok(k.clarity === 0, 'A: the oq_ad_optout cookie (the Section 12 button) -> the Clarity tag is NOT requested (got ' + k.clarity + ')');
  ok(k.ga4 === 0, 'A: the oq_ad_optout cookie -> the GA4 library is NOT requested');

  for (const [label, opts] of [['GPC false', { gpc: false }], ['GPC "true" (a string)', { gpc: 'true' }], ['cookie oq_ad_optout=0', { cookie: 'oq_ad_optout=0' }]]) {
    const r = await load(opts);
    ok(r.clarity === 1 && r.ga4 === 1, 'A CONTROL: ' + label + ' is not an opt-out -> Clarity and GA4 load');
  }
  const off = await load({ pathname: '/contractor-profile.html' });
  ok(off.clarity === 0 && off.ga4 === 1, 'A: the page-set gate is unchanged -> an off-allowlist page still gets GA4 and never Clarity');
  let threw = false; try { g.gtag('event', 'x', {}); } catch (e) { threw = true; }
  ok(!threw, 'A: an existing gtag(...) call site does not throw for an opted-out visitor');
}

// ---------------------------------------------------------------------------------------------------------------------
// B. The stored flag (profiles.ad_sharing_opt_out) for a signed-in visitor: no cookie on this device, no GPC
// ---------------------------------------------------------------------------------------------------------------------
{
  const t = await load({ cookie: SESSION, fetchImpl: rows(true) });
  ok(t.ga4 === 0, 'B: signed in, stored flag TRUE, no cookie, no GPC -> the GA4 library is NOT requested (got ' + t.ga4 + ')');
  ok(t.clarity === 0, 'B: signed in, stored flag TRUE -> the Clarity tag is NOT requested (got ' + t.clarity + ')');
  ok(wroteOptOut(t), 'B: stored flag TRUE -> the oq_ad_optout cookie is left for every later page on this device');
  ok(t.fetchCalls.length === 1, 'B: exactly ONE profile read per page load, shared by GA4 and Clarity (got ' + t.fetchCalls.length + ')');
  const call = t.fetchCalls[0];
  if (call) {
    ok(call.url === 'https://x.supabase.co/rest/v1/profiles?select=ad_sharing_opt_out&id=eq.' + UID, 'B: the read targets the caller\'s own profile row only (' + call.url + ')');
    ok(call.opts.method === 'GET' && call.opts.headers.Authorization === 'Bearer ' + TOKEN && call.opts.headers.apikey === 'anon-key', 'B: a GET with the user\'s own token and the publishable key');
  } else { ok(false, 'B: a profile read exists to inspect'); }

  const f = await load({ cookie: SESSION, fetchImpl: rows(false) });
  ok(f.ga4 === 1 && f.clarity === 1, 'B CONTROL: signed in, stored flag FALSE -> GA4 and Clarity both load (ga4 ' + f.ga4 + ', clarity ' + f.clarity + ')');
  ok(!wroteOptOut(f), 'B CONTROL: stored flag FALSE -> no opt-out cookie is written');
  const n = await load({ cookie: SESSION, fetchImpl: rows(null) });
  ok(n.ga4 === 1 && n.clarity === 1, 'B CONTROL: signed in, stored flag NULL (never set) -> both load');
  const none = await load({ cookie: '' });
  ok(none.ga4 === 1 && none.clarity === 1 && none.fetchCalls.length === 0, 'B CONTROL: no session cookie -> both load, zero profile reads');

  for (const [label, opts] of [
    ['the read rejects (network error)', { fetchImpl: () => Promise.reject(new Error('offline')) }],
    ['the read returns 401 (an expired token)', { fetchImpl: () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ message: 'JWT expired' }) }) }],
    ['the read returns a non-array body', { fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) }],
    ['the page never loads js/config.js', { cfg: null, fetchImpl: rows(false) }],
  ]) {
    const r = await load({ cookie: SESSION, ...opts });
    ok(r.ga4 === 0 && r.clarity === 0, 'B FAIL-CLOSED: signed in and ' + label + ' -> neither loads (ga4 ' + r.ga4 + ', clarity ' + r.clarity + ')');
  }
  const bad = await load({ cookie: 'sb-otterquote-at=not-a-jwt', fetchImpl: rows(false) });
  ok(bad.ga4 === 0 && bad.clarity === 0 && bad.fetchCalls.length === 0, 'B FAIL-CLOSED: an unreadable session token -> neither loads, and nothing is interpolated into a URL');
  const both = await load({ cookie: SESSION + '; oq_ad_optout=1', fetchImpl: rows(false) });
  ok(both.ga4 === 0 && both.clarity === 0 && both.fetchCalls.length === 0, 'B: the cookie wins before any read is made (stored flag false does not undo a device opt-out)');
}

// ---------------------------------------------------------------------------------------------------------------------
// C. /auth-callback never requests the GA4 library
// ---------------------------------------------------------------------------------------------------------------------
{
  for (const p of ['/auth-callback.html', '/auth-callback', '/auth-callback/']) {
    const r = await load({ pathname: p });
    ok(r.ga4 === 0, 'C: ' + p + ' (signed out, no opt-out) -> the GA4 library is NOT requested (got ' + r.ga4 + ')');
    ok(r.clarity === 0, 'C: ' + p + ' -> Clarity is not requested either (unchanged: it is off the page allowlist)');
    ok(typeof r.gtag === 'function', 'C: ' + p + ' -> the gtag stub is still defined, so the page\'s own gtag(...) calls do not throw');
  }
  const s = await load({ pathname: '/auth-callback.html', cookie: SESSION, fetchImpl: rows(false) });
  ok(s.ga4 === 0, 'C: /auth-callback.html signed in with stored flag FALSE -> still no GA4 library');
  for (const p of ['/login.html', '/dashboard.html', '/auth-callback-help.html']) {
    const r = await load({ pathname: p });
    ok(r.ga4 === 1, 'C CONTROL: ' + p + ' -> the GA4 library loads (the rule is one exact page, not a prefix)');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
