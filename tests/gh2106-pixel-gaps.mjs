/**
 * gh-2107 / #2106 gaps -- the STATIC Meta Pixel gate (js/meta-pixel-gate.js, loaded by 63 pages), REVIEW B1 and B2 on #2139
 * (5807912369, LEGAL-READ 5807914138).
 *
 * B1: a credential in the QUERY STRING must not reach Meta either (fbevents.js reads location.href for `dl`; the pixel's server config
 *     strips no keys). Exact parameter names: access_token, refresh_token, provider_token, token_hash, token. NOT `code` (this site's own
 *     referral parameter). The fragment check (gh-1969) stays.
 * B2: fbevents.js sends its own PageView on history changes unless `fbq.disablePushState = true` is set before `init`.
 *
 * Runs the REAL js/meta-pixel-gate.js in a vm context with a fake window / document / navigator.
 * Run: node tests/gh2106-pixel-gaps.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, '..', 'js', 'meta-pixel-gate.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

function run({ host = 'otterquote.com', hash = '', search = '', params = URLSearchParams } = {}) {
  const appended = [];
  const doc = {
    cookie: '',
    createElement: (tag) => ({ tag }),
    head: { appendChild: (el) => appended.push(el) },
  };
  const win = {
    location: { hostname: host, hash, search },
    addEventListener() {}, removeEventListener() {},
    requestIdleCallback: (fn) => { fn(); return 1; },
    cancelIdleCallback() {},
  };
  const ctx = { window: win, document: doc, navigator: {}, URLSearchParams: params, decodeURIComponent, setTimeout, clearTimeout, atob, encodeURIComponent, Promise, JSON };
  win.window = win;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const loaded = appended.some((e) => e.tag === 'script' && String(e.src).indexOf('connect.facebook.net/en_US/fbevents.js') !== -1);
  return { loaded, fbq: win.fbq };
}

// -- B1 ----------------------------------------------------------------------------------------------------------------------
ok(run().loaded, 'CONTROL: an ordinary visitor loads the pixel');
ok(run({ hash: '#section-2', search: '?ref=home' }).loaded, 'CONTROL: an ordinary fragment plus an ordinary query still loads');
for (const k of ['access_token', 'refresh_token', 'provider_token', 'token_hash', 'token']) {
  ok(!run({ search: '?' + k + '=abc&x=1' }).loaded, 'B1: a ?' + k + '= in the query string: the pixel never loads');
  ok(!run({ search: '?x=1&' + k + '=abc' }).loaded, 'B1: a &' + k + '= later in the query string: the pixel never loads');
}
ok(!run({ hash: '#access_token=abc' }).loaded && !run({ hash: '#refresh_token=abc' }).loaded && !run({ hash: '#provider_token=abc' }).loaded, 'the fragment guard (gh-1969) still blocks all three original names');
for (const [label, search] of [
  ["a referral ?code= (this site's own parameter)", '?code=ABC123'],
  ['a ?promocode=', '?promocode=SAVE10'],
  ['a ?zipcode=', '?zipcode=46224'],
  ['a ?mytoken= (the word inside another key)', '?mytoken=x'],
  ['a ?tokens= (a longer key)', '?tokens=2'],
  ['a value that mentions the word', '?note=access_token'],
  ['utm parameters', '?utm_source=facebook&utm_medium=cpc'],
]) {
  ok(run({ search }).loaded, 'CONTROL: ' + label + ' still loads the pixel (exact key names only)');
}
class ThrowingParams { constructor() { throw new Error('unparseable'); } }
ok(!run({ search: '?x=1', params: ThrowingParams }).loaded, 'B1: a query string that cannot be parsed fails CLOSED (the pixel does not load)');
ok(!run({ host: 'staging--jade-alpaca-b82b5e.netlify.app', search: '?code=1' }).loaded, 'a non-production host still never loads, ?code= or not');

// -- B2 ----------------------------------------------------------------------------------------------------------------------
{
  const r = run();
  ok(r.loaded && r.fbq && r.fbq.disablePushState === true, 'B2: when the pixel loads, fbq.disablePushState is true');
  const flagAt = src.indexOf('disablePushState = true');
  const initAt = src.indexOf("window.fbq('init', PIXEL_ID)");
  ok(flagAt > -1 && initAt > flagAt, "B2: the flag is set BEFORE fbq('init')");
  ok(src.split('disablePushState = true').length - 1 === 1, 'B2: set in exactly one place');
}
{
  // a model of the part of fbevents.js in question: once an event has fired, a history change sends an automatic PageView unless the flag is set
  const win = { history: { pushState() {} } };
  const doc = { cookie: '', createElement: (tag) => ({ tag }), head: { appendChild() {} } };
  Object.assign(win, { location: { hostname: 'otterquote.com', hash: '', search: '' }, addEventListener() {}, removeEventListener() {}, requestIdleCallback: (fn) => { fn(); return 1; }, cancelIdleCallback() {} });
  const ctx = { window: win, document: doc, navigator: {}, URLSearchParams, decodeURIComponent, setTimeout, clearTimeout, atob, encodeURIComponent, Promise, JSON };
  win.window = win;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const fbq = win.fbq;
  const sent = [];
  let fired = false;
  fbq.callMethod = (...a) => { if (a[0] === 'track') { fired = true; sent.push(String(a[1])); } };
  fbq.queue.forEach((q) => fbq.callMethod(...Array.from(q)));
  const orig = win.history.pushState;
  win.history.pushState = (a, b, c) => { orig(a, b, c); if (!fbq.disablePushState && fired) sent.push('PageView(auto:pushState)'); };
  fbq('track', 'Lead');
  win.history.pushState({}, '', '/faq?step=2');
  ok(!sent.includes('PageView(auto:pushState)'), 'B2: after the gate has run, a pushState sends no automatic PageView (the queued PageView and Lead only: ' + sent.join(',') + ')');
  fbq.disablePushState = false; // MODEL CONTROL: flip the flag off on the same object and the same history change DOES send one
  win.history.pushState({}, '', '/faq?step=3');
  ok(sent.includes('PageView(auto:pushState)'), 'MODEL CONTROL: with the flag off the same model DOES send an automatic PageView, so the assertion above can fail');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
