/**
 * gh-2078 (CLOSE-REVIEW FAIL 5972838358) -- the STATIC $15 measurement checkout (help-measurements.html) fires GA4 `measurement_purchase`
 * and the Meta pixel `Purchase` exactly like the React page (PR #2092 / #2107), on the confirmed-success path only, with the SAME
 * Meta eventID the server-side CAPI Purchase uses (`measurement_purchase:<paymentIntentId>`), once per PaymentIntent.
 *
 * Runs the REAL confirmHoverPayment() / fireMeasurementPurchase() source extracted from the page, and the REAL js/meta-pixel-gate.js
 * and js/ga-gate.js, in vm contexts. Suppression (internal/QA, oq_ad_optout, GPC) is proven against the real gates, not re-implemented.
 *
 * Run: node tests/gh2078-static-measurement-purchase.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'help-measurements.html'), 'utf8');
const metaGate = fs.readFileSync(path.join(root, 'js', 'meta-pixel-gate.js'), 'utf8');
const gaGate = fs.readFileSync(path.join(root, 'js', 'ga-gate.js'), 'utf8');
const capi = fs.readFileSync(path.join(root, 'supabase', 'functions', 'stripe-webhook', 'meta-capi.ts'), 'utf8');
let pass = 0, fail = 0;
function ok(c, label) { if (c) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }

function extractFn(src, name) {
  const re = new RegExp('(?:async )?function ' + name + '\\(');
  const m = re.exec(src);
  if (!m) return null;
  let d = 0, j = src.indexOf('{', m.index);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(m.index, k + 1); }
  }
  return null;
}
const confirmSrc = extractFn(html, 'confirmHoverPayment');
const fireSrc = extractFn(html, 'fireMeasurementPurchase');
const variantSrc = extractFn(html, 'getMeasurementVariant');

// -- 1. static structure -------------------------------------------------------------------------------------------------------
ok(!!confirmSrc && !!fireSrc && !!variantSrc, 'page defines confirmHoverPayment, fireMeasurementPurchase and getMeasurementVariant');
ok((html.match(/fireMeasurementPurchase\(/g) || []).length === 2, 'fireMeasurementPurchase is defined once and called from exactly one place');
ok(!!confirmSrc && confirmSrc.includes('fireMeasurementPurchase(paymentIntent.id)'), 'the single call site is inside confirmHoverPayment and passes the Stripe PaymentIntent id');
if (confirmSrc) {
  const iStripeErr = confirmSrc.indexOf('if (stripeError)');
  const iStatus = confirmSrc.indexOf("paymentIntent.status !== 'succeeded'");
  const iOrder = confirmSrc.indexOf('await Services.createMeasurementOrder');
  const iFire = confirmSrc.indexOf('fireMeasurementPurchase(paymentIntent.id)');
  ok(iStripeErr > -1 && iStatus > iStripeErr && iOrder > iStatus && iFire > iOrder, 'the purchase fires AFTER the declined-card return, the status check and the awaited order creation');
}
ok(/gtag\('event', 'measurement_purchase', \{ value: 15\.0, currency: 'USD', variant: variant \}\)/.test(html), 'GA4 event name and params match the React page (value 15, USD, variant)');
ok(html.includes("{ eventID: 'measurement_purchase:' + paymentIntentId }"), "Meta eventID is 'measurement_purchase:' + paymentIntentId");
ok(/return `measurement_purchase:\$\{paymentIntentId\}`/.test(capi), "the server-side CAPI event_id (stripe-webhook/meta-capi.ts buildCapiEventId) is the same 'measurement_purchase:<id>' string");
ok(/oq_ga4_measurement_purchase_fired_v1:/.test(html), 'once-only marker key matches the React page (hover-charge-storage.ts)');
const iGa = html.indexOf('/js/ga-gate.js'), iFlag = html.indexOf('window.OQ_META_PURCHASE_ONLY = true'), iMeta = html.indexOf('/js/meta-pixel-gate.js');
ok(iGa > -1 && iFlag > iGa && iMeta > iFlag, 'the page loads the shared gates in order: ga-gate.js, purchase-only flag, meta-pixel-gate.js (no second pixel loader)');
ok(!/connect\.facebook\.net|googletagmanager\.com\/gtag/.test(html), 'no vendor loader was added to the page');

// -- 2. behaviour: run the real confirmHoverPayment ----------------------------------------------------------------------------
const UID = '11111111-2222-3333-4444-555555555555';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const JWT = b64u({ alg: 'HS256' }) + '.' + b64u({ sub: UID }) + '.sig';
// `account`: undefined = signed out (no session cookie); true / false = the stored profiles.ad_sharing_opt_out; 'error' = the read fails (network error);
// 'http500' = the read answers non-200. The REAL js/meta-pixel-gate.js is loaded into the same window, so the page calls the REAL shared helper.
async function runCheckout({ stripeResult, orderThrows = false, store = new Map(), piId = 'pi_TEST123', variant = 'e', cookie = '', gpc = false, account, noHelper = false }) {
  const calls = [];
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  if (variant) store.set('oq_variant_v3', variant);
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, { id, style: {}, classList: { add() {} }, querySelector: () => el(id + '>'), textContent: '', innerHTML: '', disabled: false }); return els.get(id); };
  const doc = { getElementById: el, cookie: (account !== undefined ? 'sb-otterquote-at=' + JWT + '; ' : '') + cookie, createElement: (tag) => ({ tag }), head: { appendChild() {} } };
  const win = { localStorage: ls, location: { hostname: 'otterquote.com', hash: '', search: '' }, addEventListener() {}, removeEventListener() {}, requestIdleCallback: () => 1, cancelIdleCallback() {} };
  win.window = win;
  const fetchImpl = async (url) => {
    calls.push(['account-read', String(url)]);
    if (account === 'error') throw new Error('network down');
    if (account === 'http500') return { ok: false, json: async () => null };
    return { ok: true, json: async () => [{ ad_sharing_opt_out: account === true }] };
  };
  const ctx = {
    window: win, document: doc, navigator: { globalPrivacyControl: gpc },
    gtag: (...a) => calls.push(['gtag', ...a]), fbq: (...a) => calls.push(['fbq', ...a]),
    hoverStripe: { confirmCardPayment: async () => stripeResult(piId) }, hoverCardElement: {}, hoverClientSecret: 'cs_test',
    currentClaim: { id: 'claim-1' }, MEASUREMENT_PRODUCT_CODE: 'x',
    Services: { createMeasurementOrder: async () => { calls.push(['order']); if (orderThrows) throw new Error('order failed'); return {}; } },
    console: { error() {}, log() {} }, decodeURIComponent, encodeURIComponent, String, RegExp, Error, Promise, JSON, atob, URLSearchParams, setTimeout, clearTimeout,
    fetch: fetchImpl, CONFIG: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON: 'anon' },
  };
  vm.createContext(ctx);
  if (!noHelper) vm.runInContext(metaGate, ctx); // the real shared helper (and gate) on the same window
  vm.runInContext(variantSrc + '\n' + fireSrc + '\n' + confirmSrc + '\n;this.__run = confirmHoverPayment;', ctx);
  await ctx.__run();
  await new Promise((r) => setTimeout(r, 25)); // the fire-time opt-out read is not awaited by the checkout; let it settle
  return { calls, store };
}
const vendorCalls = (r) => r.calls.filter((c) => c[0] === 'gtag' || c[0] === 'fbq');
if (confirmSrc && fireSrc && variantSrc) {
  const success = (id) => ({ paymentIntent: { id, status: 'succeeded' }, error: null });
  const r1 = await runCheckout({ stripeResult: success });
  const ga = r1.calls.filter((c) => c[0] === 'gtag'), fb = r1.calls.filter((c) => c[0] === 'fbq');
  ok(ga.length === 1 && ga[0][1] === 'event' && ga[0][2] === 'measurement_purchase' && ga[0][3].value === 15 && ga[0][3].currency === 'USD' && ga[0][3].variant === 'e', 'success: exactly one GA4 measurement_purchase (value 15, USD, variant e)');
  ok(fb.length === 1 && fb[0][1] === 'track' && fb[0][2] === 'Purchase' && fb[0][3].value === 15 && fb[0][4].eventID === 'measurement_purchase:pi_TEST123', 'success: exactly one Meta Purchase carrying eventID measurement_purchase:pi_TEST123');
  ok(r1.calls.findIndex((c) => c[0] === 'order') < r1.calls.findIndex((c) => c[0] === 'gtag'), 'success: the order call resolved before the event fired');
  const r2 = await runCheckout({ stripeResult: success, store: r1.store });
  ok(r2.calls.filter((c) => c[0] === 'gtag' || c[0] === 'fbq').length === 0, 'repeat for the same PaymentIntent (retry/refresh): no second GA4 or Meta event');
  const r3 = await runCheckout({ stripeResult: success, store: r1.store, piId: 'pi_OTHER' });
  ok(r3.calls.filter((c) => c[0] === 'fbq').length === 1, 'a different PaymentIntent is a different purchase and fires once');
  const declined = await runCheckout({ stripeResult: () => ({ paymentIntent: null, error: { message: 'Your card was declined.' } }) });
  ok(declined.calls.length === 0, 'declined / cancelled card: no order, no GA4, no Meta event');
  const pending = await runCheckout({ stripeResult: (id) => ({ paymentIntent: { id, status: 'requires_action' }, error: null }) });
  ok(pending.calls.filter((c) => c[0] === 'gtag' || c[0] === 'fbq').length === 0, 'non-succeeded PaymentIntent: no event');
  const orderFail = await runCheckout({ stripeResult: success, orderThrows: true });
  ok(orderFail.calls.filter((c) => c[0] === 'gtag' || c[0] === 'fbq').length === 0, 'charge succeeded but the order step threw: no event (React fires only after the order resolves)');
  // LEGAL-READ: FAIL 5973345257 -- the opt-out is resolved at FIRE time, including the account-stored value.
  const acctOut = await runCheckout({ stripeResult: success, account: true });
  ok(vendorCalls(acctOut).length === 0, 'signed-in, account opt-out stored, no cookie, no GPC: ZERO vendor requests (no GA4, no Google conversion, no Meta)');
  ok(acctOut.calls.some((c) => c[0] === 'account-read') && acctOut.calls.some((c) => c[0] === 'order'), 'account opt-out case: the stored flag was actually read and the order still completed');
  const acctUnreadable = await runCheckout({ stripeResult: success, account: 'error' });
  ok(vendorCalls(acctUnreadable).length === 0, 'account state unreadable (network error): ZERO vendor requests (fail closed)');
  const acct500 = await runCheckout({ stripeResult: success, account: 'http500' });
  ok(vendorCalls(acct500).length === 0, 'account state unreadable (non-200 answer): ZERO vendor requests (fail closed)');
  const noHelper = await runCheckout({ stripeResult: success, noHelper: true });
  ok(vendorCalls(noHelper).length === 0, 'shared helper absent: ZERO vendor requests (fail closed)');
  const acctIn = await runCheckout({ stripeResult: success, account: false });
  ok(vendorCalls(acctIn).filter((c) => c[0] === 'gtag').length === 1 && vendorCalls(acctIn).filter((c) => c[0] === 'fbq' && c[2] === 'Purchase' && c[4].eventID === 'measurement_purchase:pi_TEST123').length === 1, 'CONTROL signed-in, stored flag false: exactly one GA4 purchase and one Meta Purchase with the shared event id');
  const cookieOut = await runCheckout({ stripeResult: success, cookie: 'oq_ad_optout=1' });
  ok(vendorCalls(cookieOut).length === 0, 'oq_ad_optout=1 cookie at fire time: zero vendor requests');
  const gpcOut = await runCheckout({ stripeResult: success, gpc: true });
  ok(vendorCalls(gpcOut).length === 0, 'GPC at fire time: zero vendor requests');
  const signedOut = await runCheckout({ stripeResult: success });
  ok(vendorCalls(signedOut).length === 2 && !signedOut.calls.some((c) => c[0] === 'account-read'), 'CONTROL signed-out visitor: behaviour unchanged (one GA4 + one Meta, no account read)');
  ok(acctOut.store.get('oq_ga4_measurement_purchase_fired_v1:pi_TEST123') === undefined, 'a withheld event does not set the once-only marker');
  const nov = await runCheckout({ stripeResult: success, variant: null });
  ok(nov.calls.find((c) => c[0] === 'gtag')[3].variant === 'unknown', "no stored arm: variant is 'unknown' (React's fallback)");
}

// -- 3. the real gates: suppression and purchase-only ---------------------------------------------------------------------------
function runMetaGate({ cookie = '', search = '', gpc = false, purchaseOnly = true, host = 'otterquote.com' } = {}) {
  const appended = [];
  const listeners = [];
  const doc = { cookie, createElement: (tag) => ({ tag }), head: { appendChild: (el) => appended.push(el) } };
  const win = { location: { hostname: host, hash: '', search }, addEventListener: (t, f, o) => listeners.push([t, o]), removeEventListener() {}, requestIdleCallback: (fn) => { fn(); return 1; }, cancelIdleCallback() {} };
  if (purchaseOnly) win.OQ_META_PURCHASE_ONLY = true;
  win.window = win;
  const ctx = { window: win, document: doc, navigator: { globalPrivacyControl: gpc }, URLSearchParams, decodeURIComponent, setTimeout, clearTimeout, atob, encodeURIComponent, Promise, JSON };
  vm.createContext(ctx);
  vm.runInContext(metaGate, ctx);
  const loaded = appended.some((a) => /fbevents\.js/.test(a.src || ''));
  const queue = (win.fbq && win.fbq.queue || []).map((a) => Array.from(a));
  return { loaded, win, queue, listeners };
}
{
  const r = runMetaGate();
  ok(r.loaded, 'real meta gate, production host, purchase-only: fbevents.js loads (so Purchase can reach Meta)');
  ok(!r.queue.some((a) => a[0] === 'track' && a[1] === 'PageView'), 'purchase-only: NO PageView queued (D-330: Purchase only on the measurement checkout)');
  ok(r.queue.some((a) => a[0] === 'init'), 'purchase-only: the pixel is still initialised');
  ok(r.listeners.some((l) => l[0] === 'pageshow' && l[1] === true), 'purchase-only: a capture-phase pageshow guard stops the bfcache PageView');
  const ctrl = runMetaGate({ purchaseOnly: false });
  ok(ctrl.queue.filter((a) => a[0] === 'track' && a[1] === 'PageView').length === 1 && !ctrl.listeners.some((l) => l[0] === 'pageshow'), 'CONTROL: without the flag every other page keeps its PageView and gets no pageshow guard');
  const optOut = runMetaGate({ cookie: 'oq_ad_optout=1' });
  ok(!optOut.loaded, 'oq_ad_optout=1: fbevents.js never loads, so the Purchase call reaches no ad network');
  const gpc = runMetaGate({ gpc: true });
  ok(!gpc.loaded, 'Global Privacy Control: fbevents.js never loads');
  const internal = runMetaGate({ search: '?oq_internal=1' });
  ok(!internal.loaded && String(internal.win.fbq).includes('function') && internal.win.fbq.queue.length === 0, 'oq_internal=1: fbevents.js never loads and fbq() queues nothing (the Purchase call is dropped)');
  internal.win.fbq('track', 'Purchase', {}, { eventID: 'x' });
  ok(internal.win.fbq.queue.length === 0, 'oq_internal=1: a Purchase call after the gate is still a dropped no-op');
  const qa = runMetaGate({ search: '?qa=1' });
  ok(!qa.loaded, 'qa=1 (gh-2356 synthetic): fbevents.js never loads');
}
{
  function runGa({ cookie = '', search = '', gpc = false } = {}) {
    const appended = [];
    const doc = { cookie, createElement: (tag) => ({ tag, style: {} }), head: { appendChild: (el) => appended.push(el) }, getElementsByTagName: () => [{ parentNode: { insertBefore: (el) => appended.push(el) } }] };
    const win = { location: { hostname: 'otterquote.com', hash: '', search, pathname: '/help-measurements' }, addEventListener() {}, removeEventListener() {}, requestIdleCallback: (fn) => { fn(); return 1; }, cancelIdleCallback() {} };
    win.window = win;
    const ctx = { window: win, document: doc, navigator: { globalPrivacyControl: gpc }, URLSearchParams, decodeURIComponent, setTimeout, clearTimeout, atob, encodeURIComponent, Promise, JSON, Date, console };
    vm.createContext(ctx);
    vm.runInContext(gaGate, ctx);
    win.gtag('event', 'measurement_purchase', { value: 15 });
    const loaded = appended.some((a) => /googletagmanager\.com/.test(a.src || ''));
    const queued = (win.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event');
    return { loaded, queued };
  }
  const normal = runGa();
  ok(normal.loaded && normal.queued.length === 1, 'real ga gate, production visitor: GA4 loads and the measurement_purchase call is queued');
  const internal = runGa({ search: '?oq_internal=1' });
  ok(!internal.loaded && internal.queued.length === 0, 'oq_internal=1: gtag() drops the measurement_purchase call and GA4 never loads');
  const optOut = runGa({ cookie: 'oq_ad_optout=1' });
  ok(!optOut.loaded, 'oq_ad_optout=1: the GA4 library never loads (the queued call goes nowhere)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
