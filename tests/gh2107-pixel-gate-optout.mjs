/**
 * gh-2107 / D-330 -- the STATIC Meta Pixel gate (js/meta-pixel-gate.js, loaded by 63 pages) honours the advertising-sharing
 * opt-out. Ben's ruling on #2078 (5805593465, item a): "For GPC=1 or ad_sharing_opt_out = true, the Meta pixel does not load."
 *
 * Runs the REAL js/meta-pixel-gate.js in a vm context with a fake window, document, navigator and cookie jar, and asserts
 * whether the fbevents.js <script> is ever inserted.
 *
 * Run: node tests/gh2107-pixel-gate-optout.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, '..', 'js', 'meta-pixel-gate.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

function run({ host = 'otterquote.com', gpc, cookie = '', hash = '', search = '' } = {}) {
  const appended = [];
  const cookieWrites = [];
  let jar = cookie;
  const doc = {
    get cookie() { return jar; },
    set cookie(v) { cookieWrites.push(v); const [kv] = v.split(';'); const [k] = kv.split('='); const rest = jar.split('; ').filter((c) => c && !c.startsWith(k + '=')); rest.push(kv); jar = rest.join('; '); },
    createElement: (tag) => ({ tag }),
    head: { appendChild: (el) => appended.push(el) },
  };
  const win = {
    location: { hostname: host, hash, search },
    addEventListener() {}, removeEventListener() {},
    requestIdleCallback: (fn) => { fn(); return 1; }, // run the idle load immediately
    cancelIdleCallback() {},
  };
  const nav = gpc === undefined ? {} : { globalPrivacyControl: gpc };
  const ctx = { window: win, document: doc, navigator: nav, URLSearchParams, decodeURIComponent, setTimeout, clearTimeout };
  win.window = win;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const fbevents = appended.filter((e) => e.tag === 'script' && String(e.src).indexOf('connect.facebook.net/en_US/fbevents.js') !== -1);
  return { loaded: fbevents.length === 1, fbevents: fbevents.length, cookieWrites, fbq: win.fbq };
}

// CONTROL: the gate still loads the pixel for an ordinary visitor on a production host
{
  const r = run();
  ok(r.loaded, 'CONTROL: an ordinary visitor on otterquote.com loads fbevents.js exactly once');
  ok(typeof r.fbq === 'function', 'CONTROL: fbq is defined');
}
// GPC on
{
  const r = run({ gpc: true });
  ok(!r.loaded, 'GPC on: fbevents.js is NOT loaded');
  ok(r.cookieWrites.some((w) => w.startsWith('oq_ad_optout=1')), 'GPC on: the oq_ad_optout cookie is left behind');
  ok(r.cookieWrites.some((w) => /Domain=\.otterquote\.com/.test(w) && /Max-Age=31536000/.test(w)), 'the cookie is scoped to .otterquote.com for one year (the same shape as oq_internal)');
  ok(typeof r.fbq === 'function', 'GPC on: fbq is still defined, so every page\'s existing fbq(...) calls stay harmless queued pushes');
  let threw = false; try { r.fbq('track', 'Lead'); } catch (e) { threw = true; }
  ok(!threw, 'GPC on: an existing fbq(...) call site does not throw');
}
// the cookie alone
{
  const r = run({ cookie: 'oq_ad_optout=1' });
  ok(!r.loaded, 'the oq_ad_optout cookie alone (no GPC) keeps fbevents.js off');
  ok(r.cookieWrites.length === 0, 'no cookie is rewritten when it is already there');
}
// signals that are NOT an opt-out
for (const [label, opts] of [['GPC false', { gpc: false }], ['GPC undefined', {}], ['GPC "true" (a string)', { gpc: 'true' }], ['GPC 1', { gpc: 1 }], ['cookie 0', { cookie: 'oq_ad_optout=0' }], ['cookie yes', { cookie: 'oq_ad_optout=yes' }]]) {
  const r = run(opts);
  ok(r.loaded, label + ': not an opt-out, the pixel loads');
}
// the existing reasons not to load still hold, independently
ok(!run({ host: 'staging--jade-alpaca-b82b5e.netlify.app' }).loaded, 'a non-production host still never loads the pixel');
ok(!run({ hash: '#access_token=abc' }).loaded, 'a URL carrying an auth token still never loads the pixel');
ok(!run({ search: '?oq_internal=1' }).loaded, 'internal traffic still never loads the pixel');
// a broken environment must not break the page or wrongly opt anyone out
{
  const win = { location: { hostname: 'otterquote.com', hash: '', search: '' }, addEventListener() {}, removeEventListener() {}, requestIdleCallback: (fn) => { fn(); return 1; }, cancelIdleCallback() {} };
  const appended = [];
  const nav = {}; Object.defineProperty(nav, 'globalPrivacyControl', { get() { throw new Error('locked down'); } });
  const ctx = { window: win, document: { cookie: '', createElement: (t) => ({ tag: t }), head: { appendChild: (e) => appended.push(e) } }, navigator: nav, URLSearchParams, decodeURIComponent, setTimeout, clearTimeout };
  win.window = win; vm.createContext(ctx);
  let threw = false; try { vm.runInContext(src, ctx); } catch (e) { threw = true; }
  ok(!threw, 'a navigator whose globalPrivacyControl getter throws does not break the page');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
