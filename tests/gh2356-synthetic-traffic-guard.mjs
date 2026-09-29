/**
 * gh-2356 -- QA walks must not fire production GA4 / Meta pixel / Meta CAPI events.
 *
 * Runs the REAL js/ga-gate.js, js/meta-pixel-gate.js and js/internal-traffic.js in a vm context (fake window / document / cookie jar),
 * has a "page" call gtag('event','generate_lead') and fbq('track','Lead') the way every static page does, and counts what could
 * reach Google / Meta: an event left on dataLayer / the fbq queue, or the vendor library <script> being inserted.
 *   walk with qa=1, TESTFBCLID123, CEO75STUB..., a test utm, or the oq_internal cookie  -> ZERO calls, ZERO library loads
 *   clean walk (real-looking fbclid, ordinary utm)                                       -> the calls and the loads still happen
 * Also proves the pattern list is ONE list: every copy (3 static files, the React twin, the Edge Function twin) is compared.
 *
 * Run: node tests/gh2356-synthetic-traffic-guard.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

function makeCtx({ host = 'otterquote.com', cookie = '', search = '' } = {}) {
  const appended = [];
  const cookieWrites = [];
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
    location: { hostname: host, hash: '', search, pathname: '/start' },
    history: { replaceState() {} },
    addEventListener() {}, removeEventListener() {},
    requestIdleCallback: (fn) => { fn(); return 1; },
    cancelIdleCallback() {},
  };
  function FakeMutationObserver() { return { observe() {} }; }
  const ctx = { window: win, document: doc, navigator: {}, URLSearchParams, decodeURIComponent, encodeURIComponent, setTimeout, clearTimeout, MutationObserver: FakeMutationObserver, Promise, JSON, atob };
  win.window = win;
  vm.createContext(ctx);
  return { ctx, win, appended, cookieWrites };
}
const scripts = (appended, sub) => appended.filter((e) => e.tag === 'script' && String(e.src).indexOf(sub) !== -1).length;

const GA_SRC = read('js/ga-gate.js');
const META_SRC = read('js/meta-pixel-gate.js');
const IT_SRC = read('js/internal-traffic.js');

// One walk: load both gates, then the page fires its conversion calls. Returns everything that could reach Google / Meta.
function walk(opts) {
  const { ctx, win, appended, cookieWrites } = makeCtx(opts);
  vm.runInContext(GA_SRC, ctx);
  vm.runInContext(META_SRC, ctx);
  win.gtag('event', 'generate_lead', { event_id: 'e1' });
  try { win.fbq('track', 'Lead'); } catch (e) { /* pages wrap this in try */ }
  const gaEvents = (win.dataLayer || []).filter((a) => a[0] === 'event' && a[1] === 'generate_lead').length;
  const fbqEvents = (win.fbq && win.fbq.queue ? win.fbq.queue : []).filter((a) => a[0] === 'track' && a[1] === 'Lead').length;
  return {
    gaEvents, fbqEvents,
    gaLib: scripts(appended, 'googletagmanager.com/gtag/js'),
    metaLib: scripts(appended, 'connect.facebook.net/en_US/fbevents.js'),
    cookieWrites, win,
  };
}
const zero = (r) => r.gaEvents === 0 && r.fbqEvents === 0 && r.gaLib === 0 && r.metaLib === 0;

// ---- CONTROL: a clean walk is unchanged -------------------------------------------------------------------------------
for (const [label, search] of [
  ['no params', ''],
  ['real-looking fbclid + ordinary utm', '?fbclid=IwAR3xYzRealClickId_abc&utm_source=facebook&utm_campaign=120234567890&utm_medium=paid'],
  ['utm_campaign that merely starts with "test"/"qa" letters (testimonial, qatar)', '?utm_campaign=testimonials-spring&utm_source=qatar-roofing'],
]) {
  const r = walk({ search });
  ok(r.gaEvents === 1, `CONTROL (${label}): gtag generate_lead is emitted once`);
  ok(r.fbqEvents === 1, `CONTROL (${label}): fbq Lead is emitted once`);
  ok(r.gaLib === 1 && r.metaLib === 1, `CONTROL (${label}): gtag.js and fbevents.js both load`);
  ok(!r.cookieWrites.some((w) => w.startsWith('oq_internal=')), `CONTROL (${label}): no oq_internal cookie is written`);
}

// ---- the QA walks ---------------------------------------------------------------------------------------------------
for (const [label, search, cookie] of [
  ['qa=1', '?qa=1', ''],
  ['fbclid=TESTFBCLID123', '?fbclid=TESTFBCLID123', ''],
  ['fbclid=CEO75STUB...', '?fbclid=CEO75STUB1234567890', ''],
  ['utm_source=test_walk', '?utm_source=test_walk', ''],
  ['utm_campaign=QA-run-7', '?utm_campaign=QA-run-7', ''],
  ['oq_internal=1 (the #2064 flag)', '?oq_internal=1', ''],
  ['oq_internal cookie, no param (a later page of a walk)', '', 'oq_internal=1'],
]) {
  const r = walk({ search, cookie });
  ok(zero(r), `QA (${label}): ZERO gtag events, ZERO fbq events, gtag.js and fbevents.js NOT loaded (ga=${r.gaEvents} fbq=${r.fbqEvents} gaLib=${r.gaLib} metaLib=${r.metaLib})`);
  ok(r.win.OQ_INTERNAL === true, `QA (${label}): window.OQ_INTERNAL is true (so start.html / partner-re.html mark the lead is_synthetic)`);
}
{
  const r = walk({ search: '?qa=1' });
  ok(r.cookieWrites.some((w) => w.startsWith('oq_internal=1')), 'qa=1 is persisted with the same oq_internal cookie #2064 uses');
  const r2 = walk({ search: '?fbclid=TESTFBCLID123' });
  ok(r2.cookieWrites.some((w) => w.startsWith('oq_internal=1')), 'a test fbclid is persisted with the same oq_internal cookie');
  // the next page of that walk carries no params at all, only the cookie
  const r3 = walk({ search: '', cookie: 'oq_internal=1' });
  ok(zero(r3), 'the following page of a walk (cookie only) still emits nothing');
}

// ---- js/internal-traffic.js (the early-set file) agrees ---------------------------------------------------------------
for (const [label, search, expected] of [['qa=1', '?qa=1', true], ['TESTFBCLID123', '?fbclid=TESTFBCLID123', true], ['clean', '?fbclid=IwAR3real', false]]) {
  const { ctx, win } = makeCtx({ search });
  vm.runInContext(IT_SRC, ctx);
  ok(win.OQ_INTERNAL === expected, `js/internal-traffic.js (${label}): window.OQ_INTERNAL === ${expected}`);
}

// ---- ONE pattern list: every copy is compared -------------------------------------------------------------------------
function block(src, tag) {
  const a = src.indexOf('// BEGIN ' + tag), b = src.indexOf('// END oq-synthetic-guard');
  if (a < 0 || b < 0) return null;
  return src.slice(a, b).split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n');
}
const staticBlocks = ['js/ga-gate.js', 'js/meta-pixel-gate.js', 'js/internal-traffic.js'].map((f) => block(read(f), 'oq-synthetic-guard (gh-2356)'));
ok(staticBlocks.every((b) => b !== null && b.includes('OQ_SYNTHETIC_VALUE_PATTERNS')), 'all three static files carry the oq-synthetic-guard block');
ok(staticBlocks[0] === staticBlocks[1] && staticBlocks[1] === staticBlocks[2], 'the block is byte-identical in ga-gate.js, meta-pixel-gate.js and internal-traffic.js');
const grab = (src, name) => (src.match(new RegExp(name + '[^=]*=\\s*(\\[[^\\]]*\\](?:\\s*\\/[^\\n]*)?)')) || [])[1];
const patLine = (src) => (src.match(/OQ_SYNTHETIC_VALUE_PATTERNS[^=]*=\s*(\[.*\]);/) || [])[1];
const keyLine = (src) => (src.match(/OQ_SYNTHETIC_PARAM_KEYS[^=]*=\s*(\[.*\]);/) || [])[1];
const norm = (s) => String(s).replace(/"/g, "'").replace(/\s+/g, '');
const staticSrc = read('js/ga-gate.js'), tsSrc = read('react-app/app/lib/internal-traffic.ts'), edgeSrc = read('supabase/functions/_shared/synthetic-traffic.ts');
for (const [name, src] of [['react-app/app/lib/internal-traffic.ts', tsSrc], ['supabase/functions/_shared/synthetic-traffic.ts', edgeSrc]]) {
  ok(patLine(src) && norm(patLine(src)) === norm(patLine(staticSrc)), `${name}: the pattern list equals the static list`);
  ok(keyLine(src) && norm(keyLine(src)) === norm(keyLine(staticSrc)), `${name}: the param-key list equals the static list`);
}

// ---- call sites are instrumented (server side + React) ----------------------------------------------------------------
for (const f of ['supabase/functions/create-invoice/index.ts', 'supabase/functions/docusign-webhook/index.ts', 'supabase/functions/create-docusign-envelope/index.ts']) {
  ok(read(f).includes('shouldSuppressAnalyticsDispatch("ga4_mp"'), `${f}: GA4 Measurement Protocol send is gated`);
}
ok(read('supabase/functions/stripe-webhook/index.ts').includes('shouldSuppressAnalyticsDispatch("meta_capi"'), 'stripe-webhook: Meta CAPI Purchase send is gated');
ok(/isInternalTraffic\(\)\) return;\s*\n\s*const gtag = getGtag/.test(read('react-app/app/lib/track.ts')), 'react track(): gated on isInternalTraffic()');
ok(read('react-app/app/lib/track.ts').includes('gh-2356: a QA walk emits no Meta pixel event'), 'react fbqTrack(): gated on isInternalTraffic()');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
