/**
 * gh-2122 -- Arm F, the homeowner short path: the lead is saved in <=4 taps,
 * BEFORE any account exists (checklist row 1.1 on #2121).
 *
 * Working test, written before any Arm F code, in this issue's own terms:
 *   - Screen 1 is ONE tap (funding), screen 2 the address, screen 3 name +
 *     phone/email; the `leads` row is written on the screen-3 submit, first,
 *     and NOTHING on screens 1-3 touches an account (the bridge stub has no
 *     `sb.auth`, so any auth call would throw and fail the run).
 *   - Every router event carries variant / step / step_index / ua_context,
 *     and lead_id on every event after the save (#2096 lessons, Ben's SLOT
 *     OPEN comment 5802542341). That is asserted against the REAL
 *     trackRouter extracted verbatim from start.html, on the payloads that
 *     reach gtag -- not on a stub that would trivially pass.
 *   - The conversion (GA4 generate_lead + Meta Lead) is counted exactly once,
 *     on the event that fires before the thank-you screen and before any
 *     later redirect, with ONE shared event_id. A failed insert counts none.
 *   - The approved copy (ARM F COPY -- APPROVED, comment 5801479035 ->
 *     table 5801132485) is one constants block, and the consent and privacy
 *     lines are BYTE-IDENTICAL to the approved draft (pinned literally below;
 *     the R-177 LEGAL-READ checks the shipped text against that draft).
 *   - Ben's ruling on #2122 (comment 5802853627): funding, address, fbc/fbp and consent
 *     text NEVER reach GA4 or Meta (analytics carry variant / step / step_index /
 *     ua_context / lead_id, plus event_id on generate_lead). The save order is
 *     insert -> set_lead_role -> the record-lead-details Edge Function with the funding
 *     answer, address, fbc/fbp and the exact consent record; one retry; Sentry (lead id
 *     only) on final failure; the flow is never blocked.
 *   - D-299 (Ben, ruling #2122 comment 5803979399): the details call (funding, address, fbc/fbp, the
 *     consent record, the PHONE AS TYPED and the submitted form VALUES) starts the moment the insert
 *     resolves -- no wait, in parallel with set_lead_role -- as a keepalive fetch that is a simple request
 *     (text/plain, no custom headers, no CORS preflight), with navigator.sendBeacon as the fallback on
 *     pagehide / hidden if the write is not yet confirmed. A pagehide right after the insert must still
 *     send the details request.
 *   - After the lead is saved a pagehide is NOT an abandonment (real
 *     start.html abandon-beacon code, with a negative control that removes
 *     the suppression and watches the false abandon fire).
 *
 * Same harness philosophy as tests/gh2096-dropoff-layer.mjs and
 * tests/gh2096-abandon-beacon-restore.mjs: no browser engine in this repo, so
 * the ACTUAL js/router-variant-f.js runs in a Node `vm` context behind a
 * minimal DOM shim, and the real start.html blocks are extracted by anchor
 * text at run time, never hand-retyped. This is a vm result, NOT a real-browser
 * result; the phone walks in the Facebook in-app browser (issue's working test
 * points 1-6) remain Sloane's, in production.
 *
 * Run: node tests/gh2122-arm-f.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const startSrc = fs.readFileSync(path.join(repoRoot, 'start.html'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

let moduleSrc = null;
try { moduleSrc = fs.readFileSync(path.join(repoRoot, 'js', 'router-variant-f.js'), 'utf8'); } catch (e) { /* asserted below */ }
ok(moduleSrc !== null, 'js/router-variant-f.js exists');
if (moduleSrc === null) { console.log('\n=== Summary ===\n' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }

// ── The approved copy, pinned literally for the two LEGAL keys only. Every
// other key is read from the module's own constants block, so a Sloane copy
// swap stays a one-line change; the legal lines may not drift without this
// file (and the LEGAL-READ) noticing. Source: comment 5801132485 table. ──
const APPROVED_CONSENT = 'I agree that OtterQuote / Stellar Edge Services may call or text me at the number above about my roof assessment, including by autodialer or prerecorded/artificial voice. Consent is not a condition of purchase. Msg & data rates may apply.';
const APPROVED_PRIVACY = 'By continuing, you agree to our Privacy Policy and Terms.';
// The complete approved key list (32 table keys + the approved no-call line = 33). The block must contain exactly these.
const APPROVED_KEYS = [
  'arm_f_s1_headline', 'arm_f_s1_subhead', 'arm_f_s1_question_label',
  'arm_f_s1_option_insurance', 'arm_f_s1_option_cash', 'arm_f_s1_option_unsure',
  'arm_f_s2_headline', 'arm_f_s2_subhead', 'arm_f_s2_placeholder', 'arm_f_s2_button_continue', 'arm_f_s2_error_required',
  'arm_f_s3_headline', 'arm_f_s3_subhead', 'arm_f_s3_label_name', 'arm_f_s3_placeholder_name',
  'arm_f_s3_label_phone', 'arm_f_s3_placeholder_phone', 'arm_f_s3_label_email', 'arm_f_s3_placeholder_email',
  'arm_f_s3_consent_checkbox', 'arm_f_s3_privacy_line', 'arm_f_s3_button_submit',
  'arm_f_error_name', 'arm_f_error_contact_required', 'arm_f_error_phone_invalid', 'arm_f_error_email_invalid', 'arm_f_error_generic',
  'arm_f_s4_headline', 'arm_f_s4_body_in_window', 'arm_f_s4_body_after_hours', 'arm_f_s4_confirm_email_only',
  'arm_f_s4_button_measure', 'arm_f_s4_button_losssheet'
];

// ── Extract the real start.html blocks by anchor text (throws loudly if the
// shape of start.html changed, so a moved anchor is a visible failure). ──
function extractBetween(src, startAnchor, endAnchor, label) {
  const s = src.indexOf(startAnchor);
  if (s === -1) throw new Error('extraction anchor not found (start): ' + label);
  const e = src.indexOf(endAnchor, s);
  if (e === -1) throw new Error('extraction anchor not found (end): ' + label);
  return src.slice(s, e);
}
const blockTrack = extractBetween(startSrc, 'var STEP_INDEX_AB = {', '\n\n  // ── Phone validation:', 'STEP_INDEX_AB..trackRouter');
const blockRedirect = extractBetween(startSrc, 'function redirectTo(dest, preBuilt) {', '\n\n  // gh-1994 fix round 2 (Ben, non-blocking item)', 'redirectTo');
const blockAbandonListeners = extractBetween(startSrc, 'var ABANDON_HIDDEN_GRACE_MS = 5000;', "\n\n  // gh-2017: arm C's bridge, assembled LAST", 'abandon beacon');
const blockMarkSaved = extractBetween(startSrc, 'function markLeadSaved() {', '\n\n', 'markLeadSaved');
ok(blockMarkSaved.indexOf('abandonSuppressedByNav = true;') !== -1, 'start.html markLeadSaved() sets abandonSuppressedByNav = true');

// ── Minimal DOM shim, same surface as tests/gh2096-dropoff-layer.mjs, plus
// checkbox `checked`, `disabled` propagation and a document that can hold
// listeners (the abandon beacon registers visibilitychange on it). ──
function makeDom() {
  const registry = {};
  function dispatchDomEvent(target, type) {
    const event = { type, preventDefault() {}, stopPropagation() {} };
    (target._listeners[type] || []).forEach((entry) => entry.fn(event));
  }
  function createElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(), _classes: [], children: [], attributes: {}, style: {}, _listeners: {},
      _text: '', parentNode: null,
      get className() { return this._classes.join(' '); },
      set className(v) { this._classes = v ? String(v).split(/\s+/).filter(Boolean) : []; },
      get textContent() {
        if (this.children.length) return this.children.map((c) => (c.textContent != null ? c.textContent : '')).join('');
        return this._text;
      },
      set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; },
      set innerHTML(v) { this._text = String(v); this.children = []; },
      get firstChild() { return this.children.length ? this.children[0] : null; },
      appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
      removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
      setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') { this.id = v; registry[v] = this; } },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
      addEventListener(evt, fn) { (this._listeners[evt] = this._listeners[evt] || []).push({ fn }); },
      focus() {},
      dispatchClick() { if (this.disabled) return; dispatchDomEvent(this, 'click'); },
      classList: { add() {}, remove() {}, toggle() {} }
    };
    if (tag === 'input') { el.value = ''; el.checked = false; }
    return el;
  }
  const windowListeners = {};
  const document = {
    createElement,
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    getElementById: (id) => registry[id] || null,
    visibilityState: 'visible',
    addEventListener(evt, fn) { (windowListeners[evt] = windowListeners[evt] || []).push(fn); },
    body: { appendChild: (el) => el }
  };
  return { document, windowListeners };
}
function flatten(el) { const out = [el]; (el.children || []).forEach((c) => out.push(...flatten(c))); return out; }
const byId = (root, id) => flatten(root).find((c) => c.id === id);
const buttons = (root) => flatten(root).filter((c) => c.tagName === 'BUTTON');
const buttonByText = (root, text) => buttons(root).find((b) => b.textContent === text);
const settle = () => new Promise((r) => setImmediate(r));
async function settleN(n) { for (let i = 0; i < n; i++) await settle(); }

function makeFakeDate(fixedMs) {
  return class extends Date {
    constructor(...a) { if (a.length === 0) super(fixedMs); else super(...a); }
    static now() { return fixedMs; }
  };
}

const PAGE_URL = 'https://otterquote.com/start?v=f&utm_source=fb&fbclid=IwAR123';
const FB_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/450.0]';
const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1';

// opts: nowIso, ua, insertFails (n times), insertThrows (sync throw), roleMode ('ok'|'error'|'false'|'fail-once'|'hang'), detailsMode, noSuppress, Intl
function buildF(opts) {
  opts = opts || {};
  const { document, windowListeners } = makeDom();
  const root = document.createElement('div');
  root.setAttribute('id', 'routerFRoot');
  const gtagCalls = [];
  const fbqCalls = [];
  const clarityCalls = [];
  const insertCalls = [];
  const rpcCalls = [];
  const redirects = [];
  const errors = [];
  const order = [];
  const detailsCalls = [];
  const sentry = [];
  let detailsAttempts = 0;
  let roleAttempts = 0;
  let insertFailuresLeft = opts.insertFails || 0;
  let nextLead = 1;

  const fakeWindow = { location: { href: PAGE_URL, search: '?v=f&utm_source=fb&fbclid=IwAR123' }, addEventListener(evt, fn) { (windowListeners[evt] = windowListeners[evt] || []).push(fn); } };
  const clarityFn = function () { clarityCalls.push([].slice.call(arguments)); };
  fakeWindow.clarity = clarityFn;
  fakeWindow.Sentry = { captureMessage: function (msg, ctx) { sentry.push({ msg, ctx }); } };
  document.cookie = opts.cookie === undefined ? '_fbc=fb.1.1700000000.cookieFbc; _fbp=fb.1.1700000000.cookieFbp' : opts.cookie;
  const beacons = [];
  const fetchStub = (url, init) => {
    detailsAttempts++;
    order.push('details');
    detailsCalls.push({ name: 'record-lead-details', url, init, body: JSON.parse(init.body) });
    const mode = opts.detailsMode || 'ok';
    const reply = (ok, status, data) => { const p = Promise.resolve({ ok, status, json: () => Promise.resolve(data) }); return { then: (a, b) => p.then(a, b) }; };
    if (mode === 'hang') return new Promise(() => {}); // a real never-settling request, so .then() chains behave as in a browser
    if (mode === 'fail-always') return reply(false, 500, { ok: false });
    if (mode === 'fail-once' && detailsAttempts === 1) return reply(false, 500, { ok: false });
    if (mode === 'notok') return reply(true, 200, { ok: false, error: 'x' });
    if (mode === 'out-of-scope') return reply(true, 200, { ok: false, reason: 'lead_out_of_scope' });
    return reply(true, 200, { ok: true });
  };
  const fixed = Date.parse(opts.nowIso || '2026-09-23T15:00:00Z'); // 11:00 America/Indiana/Indianapolis
  const sandbox = {
    window: fakeWindow, document, navigator: { userAgent: opts.ua || SAFARI_UA, sendBeacon: (url, blob) => { beacons.push({ url, blob }); return !opts.beaconFails; } }, Blob,
    fetch: opts.noFetch ? undefined : fetchStub, console, Promise,
    // Timers are scaled down 100x so the 3s / 6s guards and the 800ms retry delay run in milliseconds
    // while keeping their ORDER (retry 8ms < role wait 30ms < flow guard 60ms).
    setTimeout: (fn, ms) => setTimeout(fn, Math.ceil((ms || 0) / 100)), clearTimeout,
    URLSearchParams, decodeURIComponent,
    Intl: opts.Intl === undefined ? Intl : opts.Intl, Date: makeFakeDate(fixed), Math, String, Object, Array, RegExp, JSON, Number, parseInt, isNaN, encodeURIComponent,
    gtag: function (action, name, params) { gtagCalls.push({ action, name, params }); },
    fbq: function () { fbqCalls.push([].slice.call(arguments)); },
    clarity: clarityFn
  };
  const ctx = vm.createContext(sandbox);
  const glue = [
    "var variant = 'f';", 'var oqInternalWalk = false;', 'var leadId = null;', 'var _oqTrackQueue = [];',
    'function trackStepComplete() {}', 'function renderStep() {}', 'function appendParams(base, obj) {',
    "  var parts = Object.keys(obj || {}).filter(function (k) { return obj[k]; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]); });",
    "  if (!parts.length) return base; return base + (base.indexOf('?') === -1 ? '?' : '&') + parts.join('&'); }",
    "function collectAttribution() { return { utm_source: 'fb', fbclid: 'abc', v: 'f' }; }"
  ].join('\n');
  vm.runInContext('(function () {\n' + glue + '\n' + blockTrack + '\n' + blockRedirect + '\n' + blockMarkSaved + '\n' + blockAbandonListeners + '\n' +
    'window.__t = { trackRouter: trackRouter, redirectTo: redirectTo, markLeadSaved: markLeadSaved, appendParams: appendParams, collectAttribution: collectAttribution,' +
    ' setLeadId: function (v) { leadId = v; } };\n})();', ctx, { filename: 'start.html (extracted blocks)' });
  const T = fakeWindow.__t;

  const bridge = {
    get sb() {
      return {
        functions: {
          invoke: (name, args) => {
            detailsAttempts++;
            order.push('details');
            detailsCalls.push({ name, body: args && args.body });
            const mode = opts.detailsMode || 'ok';
            const respond = (v) => { const p = Promise.resolve(v); return { then: (a, b) => p.then(a, b) }; };
            if (mode === 'hang') return { then: () => {} };
            if (mode === 'fail-always') return respond({ data: null, error: { name: 'FunctionsHttpError' } });
            if (mode === 'fail-once' && detailsAttempts === 1) return respond({ data: null, error: { name: 'FunctionsHttpError' } });
            if (mode === 'notok') return respond({ data: { ok: false, error: 'x' }, error: null });
            if (mode === 'out-of-scope') return respond({ data: { ok: false, reason: 'lead_out_of_scope' }, error: null });
            return respond({ data: { ok: true }, error: null });
          }
        },
        rpc: (name, args) => {
          order.push(name);
          rpcCalls.push({ name, args });
          if (opts.roleMode === 'hang') return { then: () => {} };
          if (name === 'set_lead_role') roleAttempts++;
          let result = { data: true, error: null };
          if (opts.roleMode === 'error') result = { data: null, error: { name: 'PostgrestError' } };
          if (opts.roleMode === 'false') result = { data: false, error: null };
          if (opts.roleMode === 'fail-once' && roleAttempts === 1) result = { data: null, error: { name: 'PostgrestError' } };
          const p = Promise.resolve(result);
          return { then: (a, b) => p.then(a, b) };
        }
        // deliberately NO `auth`: Arm F must never touch an account.
      };
    },
    trackRouter: T.trackRouter,
    collectAttribution: T.collectAttribution,
    appendParams: T.appendParams,
    redirectTo: T.redirectTo,
    markLeadSaved: opts.noSuppress ? function () {} : T.markLeadSaved,
    showError: (msg) => { errors.push(msg); },
    insertFreshLead: function (name, email, phone, isSynthetic, variantOverride, extra) {
      order.push('insert');
      if (opts.insertThrows) { throw new TypeError("Cannot read properties of null (reading 'from')"); }
      insertCalls.push({ name, email, phone, isSynthetic, variantOverride, extra, eventsBefore: gtagCalls.length, fbqBefore: fbqCalls.length });
      if (insertFailuresLeft > 0) { insertFailuresLeft--; return Promise.reject(new Error('insert failed')); }
      const id = '00000000-0000-4000-8000-00000000000' + (nextLead++);
      T.setLeadId(id); // real insertFreshLead sets start.html's leadId before resolving
      return Promise.resolve(id);
    },
    ROLE_DESTINATIONS: { homeowner: 'https://app.otterquote.com/get-started' },
    detailsUrl: opts.noFetch ? null : 'https://proj.supabase.co/functions/v1/record-lead-details',
    anonKey: 'anon-key-123'
  };
  vm.runInContext(moduleSrc, ctx, { filename: 'js/router-variant-f.js' });
  const RVF = fakeWindow.RouterVariantF;
  if (!RVF || typeof RVF.init !== 'function') throw new Error('window.RouterVariantF.init was not defined after loading js/router-variant-f.js');
  RVF.init(bridge, root);
  return {
    beacons, fireVisibilityHidden: () => { document.visibilityState = 'hidden'; (windowListeners.visibilitychange || []).forEach((fn) => fn()); },
    RVF, root, bridge, gtagCalls, fbqCalls, clarityCalls, insertCalls, rpcCalls, redirects, errors, fakeWindow, document, order, detailsCalls, sentry,
    firePagehide: () => (windowListeners.pagehide || []).forEach((fn) => fn()),
    ev: (name) => gtagCalls.filter((c) => c.name === name),
    leadFbq: () => fbqCalls.filter((c) => c[0] === 'track' && c[1] === 'Lead')
  };
}

const COPY = (function () { const s = buildF(); return s.RVF.COPY; })();
// ARM F COPY -- APPROVED (no-call variant), #2122 comment 5804614805, Dustin's ruling: 'Change "DUSTIN" to "we"'. Straight apostrophe (0x27).
const APPROVED_NOCALL = "Thanks. We've got your request. We will email you shortly with next steps.";

function toAddress(s, addr) { byId(s.root, 'rfAddress').value = addr; buttonByText(s.root, COPY.arm_f_s2_button_continue).dispatchClick(); }
function pickFunding(s, label) { buttonByText(s.root, label).dispatchClick(); }
function fillContact(s, v) {
  byId(s.root, 'rfName').value = v.name != null ? v.name : '';
  byId(s.root, 'rfPhone').value = v.phone != null ? v.phone : '';
  byId(s.root, 'rfEmail').value = v.email != null ? v.email : '';
  byId(s.root, 'rfConsent').checked = !!v.consent;
}
function submit(s) { buttonByText(s.root, COPY.arm_f_s3_button_submit).dispatchClick(); }
function drive(s, v, funding) {
  pickFunding(s, funding || COPY.arm_f_s1_option_insurance);
  toAddress(s, v.address || '123 Main St, Indianapolis, IN 46204');
  fillContact(s, v);
}
const GOOD = { name: 'Jane', phone: '(317) 255-0142', email: 'jane@example.com', consent: false };
const CALLABLE = { name: 'Jane', phone: '(317) 255-0142', email: 'jane@example.com', consent: true }; // a phone AND a ticked box: the only lead the thank-you screen may promise a call to

async function main() {
  // ═══ Copy: one constants block, exactly the approved keys, legal lines byte-identical. ═══
  ok(COPY && typeof COPY === 'object', 'RouterVariantF.COPY is exposed as the one constants block');
  const keys = Object.keys(COPY).sort();
  ok(JSON.stringify(keys.filter((k) => k.indexOf('arm_f_') === 0)) === JSON.stringify(APPROVED_KEYS.slice().sort()),
    'the constants block holds exactly the 33 approved arm_f_* keys (the 32 of the table plus the approved no-call line) (missing: ' +
    APPROVED_KEYS.filter((k) => keys.indexOf(k) === -1).join(',') + ' | extra: ' + keys.filter((k) => k.indexOf('arm_f_') === 0 && APPROVED_KEYS.indexOf(k) === -1).join(',') + ')');
  ok(COPY.arm_f_s3_consent_checkbox === APPROVED_CONSENT, 'consent line is BYTE-IDENTICAL to the approved draft (arm_f_s3_consent_checkbox)');
  ok(COPY.arm_f_s3_privacy_line === APPROVED_PRIVACY, 'privacy line is BYTE-IDENTICAL to the approved draft (arm_f_s3_privacy_line)');
  ok(APPROVED_KEYS.every((k) => typeof COPY[k] === 'string' && COPY[k].length > 0), 'every approved key is a non-empty string');
  ok(/\bin the next few minutes\b/i.test(Object.values(COPY).join('|')) === false, 'no unapproved "next few minutes" promise: the approved copy carries the 8am-8pm bound');
  ok(!/attorney/i.test(Object.values(COPY).join('|')), 'no "attorney" framing anywhere in the copy (D-326/D-332)');
  ok(Object.isFrozen(COPY), 'the constants block is frozen (no runtime mutation of legal copy)');

  // ═══ F1: screen 1 -- one tap, no role question, no account, no lead yet. ═══
  {
    const s = buildF({ ua: FB_UA });
    const text = flatten(s.root).map((c) => c.textContent).join('|');
    ok(text.indexOf(COPY.arm_f_s1_headline) !== -1 && text.indexOf(COPY.arm_f_s1_subhead) !== -1 && text.indexOf(COPY.arm_f_s1_question_label) !== -1,
      'screen 1 renders the approved headline, subhead and question label');
    const opts = buttons(s.root).map((b) => b.textContent);
    ok(JSON.stringify(opts) === JSON.stringify([COPY.arm_f_s1_option_insurance, COPY.arm_f_s1_option_cash, COPY.arm_f_s1_option_unsure]),
      'screen 1 has exactly the three funding options and nothing else (no role question, no header nav, no other button)');
    ok(flatten(s.root).filter((c) => c.tagName === 'A' || c.tagName === 'INPUT').length === 0, 'screen 1 has no link that leaves the page and no input');
    ok(s.insertCalls.length === 0 && s.rpcCalls.length === 0, 'nothing is written on screen 1');
    const v = s.ev('router_step_view');
    ok(v.length === 1 && v[0].params.step === 'f-funding' && v[0].params.step_index === 1 && v[0].params.variant === 'f' && v[0].params.ua_context === 'fb_iab',
      'screen 1 fires router_step_view {f-funding, step_index 1, variant f, ua_context fb_iab} (real trackRouter payload)');
  }

  // ═══ F2: funding -> address -> contact; validation; step events. ═══
  {
    const s = buildF();
    pickFunding(s, COPY.arm_f_s1_option_cash);
    ok(s.ev('router_funding_selected').length === 0 && s.gtagCalls.every((c) => JSON.stringify(c.params).indexOf('cash') === -1),
      'the funding tap fires NO funding event and the funding value appears in no analytics call (Ben: no funding in GA4/Meta)');
    ok(byId(s.root, 'rfAddress') && byId(s.root, 'rfAddress').getAttribute('placeholder') === COPY.arm_f_s2_placeholder, 'screen 2 shows the address field with the approved placeholder');
    ok(flatten(s.root).filter((c) => c.tagName === 'INPUT').length === 1, 'screen 2 is a single text field (no autocomplete exists in /start)');
    buttonByText(s.root, COPY.arm_f_s2_button_continue).dispatchClick();
    ok(flatten(s.root).some((c) => c.textContent === COPY.arm_f_s2_error_required), 'an empty address shows the approved required error and does not advance');
    ok(s.ev('router_step_view').filter((e) => e.params.step === 'f-contact').length === 0, 'no f-contact view while the address is empty');
    toAddress(s, '123 Main St, Indianapolis, IN 46204');
    const views = s.ev('router_step_view').map((e) => e.params.step + ':' + e.params.step_index);
    ok(JSON.stringify(views) === JSON.stringify(['f-funding:1', 'f-address:2', 'f-contact:3']), 'views f-funding:1, f-address:2, f-contact:3 in order (' + views.join(',') + ')');
    const comp = s.ev('router_step_complete').map((e) => e.params.step + ':' + e.params.step_index);
    ok(JSON.stringify(comp) === JSON.stringify(['f-funding:1', 'f-address:2']), 'completes f-funding:1 and f-address:2 carry step_index (' + comp.join(',') + ')');
  }

  // ═══ F3: screen 3 markup and validation. ═══
  {
    const s = buildF();
    drive(s, GOOD);
    const consent = byId(s.root, 'rfConsent');
    ok(consent && consent.checked === false && consent.getAttribute('type') === 'checkbox', 'the consent checkbox is unchecked by default');
    const consentLabel = flatten(s.root).find((c) => c.tagName === 'LABEL' && c.getAttribute('for') === 'rfConsent');
    ok(consentLabel && consentLabel.textContent === APPROVED_CONSENT, 'the rendered consent label text is byte-identical to the approved draft');
    const privacy = byId(s.root, 'rfPrivacy');
    ok(privacy && privacy.textContent === APPROVED_PRIVACY, 'the rendered privacy line text is byte-identical to the approved draft');
    const links = flatten(privacy).filter((c) => c.tagName === 'A');
    ok(links.length === 2 && links[0].getAttribute('href') === 'privacy.html' && links[1].getAttribute('href') === 'terms.html' && links.every((a) => a.getAttribute('target') === null),
      'privacy line links to privacy.html and terms.html in the SAME tab (spec 8: no new tabs)');
    ok(flatten(s.root).every((c) => c.tagName !== 'INPUT' || c.getAttribute('type') !== 'file'), 'no file picker on screens 1-3 (spec 8)');
    ok(!/google|oauth|sign in|sign-in|password/i.test(flatten(s.root).map((c) => c.textContent + (c.getAttribute && c.getAttribute('type') || '')).join('|')), 'no Google OAuth, sign-in or password field on screens 1-3 (spec 8)');
    ok(byId(s.root, 'rfName').getAttribute('placeholder') === COPY.arm_f_s3_placeholder_name && byId(s.root, 'rfPhone').getAttribute('placeholder') === COPY.arm_f_s3_placeholder_phone && byId(s.root, 'rfEmail').getAttribute('placeholder') === COPY.arm_f_s3_placeholder_email,
      'the three contact fields carry the approved placeholders');

    function errShown(msg) { return flatten(s.root).some((c) => c.textContent === msg); }
    fillContact(s, { name: '', phone: GOOD.phone, email: '' }); submit(s);
    ok(errShown(COPY.arm_f_error_name), 'missing first name shows the approved name error');
    fillContact(s, { name: 'Jane', phone: '', email: '' }); submit(s);
    ok(errShown(COPY.arm_f_error_contact_required), 'no phone AND no email shows the approved contact-required error');
    fillContact(s, { name: 'Jane', phone: '12345', email: '' }); submit(s);
    ok(errShown(COPY.arm_f_error_phone_invalid), 'a malformed phone shows the approved phone error');
    fillContact(s, { name: 'Jane', phone: '', email: 'not-an-email' }); submit(s);
    ok(errShown(COPY.arm_f_error_email_invalid), 'a malformed email shows the approved email error');
    ok(s.insertCalls.length === 0 && s.ev('generate_lead').length === 0 && s.leadFbq().length === 0, 'four invalid submits: zero inserts, zero conversion events');
  }

  // ═══ F4: the save. Lead first, before anything else; base columns only; no account. ═══
  {
    const s = buildF({ ua: FB_UA });
    drive(s, { name: 'Jane', phone: '(317) 255-0142', email: 'Jane@Example.com', consent: true, address: '123 Main St, Indianapolis, IN 46204' }, COPY.arm_f_s1_option_unsure);
    submit(s);
    await settleN(3);
    ok(s.insertCalls.length === 1, 'exactly one leads insert on submit');
    const ins = s.insertCalls[0];
    ok(ins.name === 'Jane' && ins.email === 'jane@example.com' && ins.phone === '3172550142', 'insert carries name, lower-cased email and 10-digit phone (' + JSON.stringify([ins.name, ins.email, ins.phone]) + ')');
    ok(ins.extra && ins.extra.zip === '46204' && Object.keys(ins.extra).join() === 'zip', 'the only extra column is zip, parsed from the address (existing column; funding/address/fbc have NO column yet)');
    const firedBeforeInsert = s.gtagCalls.slice(0, ins.eventsBefore).map((c) => c.name);
    ok(['router_contact_submitted', 'generate_lead'].every((n) => firedBeforeInsert.indexOf(n) === -1) && s.ev('router_contact_submitted').length === 1,
      'the lead insert happens BEFORE any submit/conversion event (events before insert: ' + firedBeforeInsert.join(',') + ')');
    ok(ins.fbqBefore === 0, 'no Meta call before the lead exists');
    const role = s.rpcCalls.filter((c) => c.name === 'set_lead_role');
    ok(role.length === 1 && role[0].args.p_role === 'homeowner' && role[0].args.p_lead_id === '00000000-0000-4000-8000-000000000001',
      'set_lead_role(homeowner) fires once after the save, which is what trips the #1932 new-lead alert');
    ok(s.rpcCalls.every((c) => ['set_lead_role'].indexOf(c.name) !== -1), 'no other RPC (no update_lead_contact, no auth) is called');
    ok(JSON.stringify(s.order) === JSON.stringify(['insert', 'details', 'set_lead_role']), "the insert is first; the details call and set_lead_role both follow immediately, details first (ruling 5803979399): " + s.order.join(' > '));
  }

  // ═══ F5: phone-only and email-only both save; blank email is "" (leads.email is NOT NULL, never a fake address). ═══
  {
    const a = buildF(); drive(a, { name: 'Pat', phone: '317-255-0142', email: '' }); submit(a); await settleN(3);
    ok(a.insertCalls.length === 1 && a.insertCalls[0].email === '' && a.insertCalls[0].phone === '3172550142', 'phone-only saves with email "" (NOT NULL column; no synthetic address)');
    const b = buildF(); drive(b, { name: 'Pat', phone: '', email: 'pat@example.com' }); submit(b); await settleN(3);
    ok(b.insertCalls.length === 1 && b.insertCalls[0].phone === null && b.insertCalls[0].email === 'pat@example.com', 'email-only saves with phone null');
  }

  // ═══ F6: EVERY router event carries variant/step/step_index/ua_context; lead_id after the save (#2096 lessons). ═══
  {
    const s = buildF({ ua: FB_UA });
    drive(s, GOOD);
    submit(s); await settleN(3);
    const routerish = s.gtagCalls.filter((c) => c.action === 'event');
    const bad = routerish.filter((c) => !(c.params.variant === 'f' && typeof c.params.step === 'string' && typeof c.params.step_index === 'number' && c.params.ua_context === 'fb_iab'));
    ok(routerish.length >= 8 && bad.length === 0, 'all ' + routerish.length + ' events carry variant f / step / numeric step_index / ua_context (offenders: ' + bad.map((c) => c.name + ':' + c.params.step).join(',') + ')');
    const idxSubmitted = routerish.findIndex((c) => c.name === 'router_contact_submitted');
    const before = routerish.slice(0, idxSubmitted);
    const after = routerish.slice(idxSubmitted);
    ok(before.every((c) => c.params.lead_id === undefined), 'no lead_id on any event before the save');
    ok(after.length > 0 && after.every((c) => c.params.lead_id === '00000000-0000-4000-8000-000000000001'), 'lead_id is on EVERY event from the save onward (' + after.map((c) => c.name).join(',') + ')');
    ok(s.clarityCalls.some((c) => c[0] === 'set' && c[1] === 'step' && c[2] === 'f-contact') && s.clarityCalls.some((c) => c[0] === 'event' && c[1] === 'router_f-thanks'),
      'Clarity receives the step tag and router_<step> event on the F screens');
    const ua = buildF({ ua: SAFARI_UA }); ok(ua.ev('router_step_view')[0].params.ua_context === 'other', 'a plain Safari UA reports ua_context other');
  }

  // ═══ F7: the conversion is counted ONCE, on the event before the thank-you screen, with ONE event_id. ═══
  {
    const s = buildF();
    drive(s, GOOD);
    submit(s); submit(s); // double tap while the insert is in flight
    await settleN(4);
    ok(s.insertCalls.length === 1, 'a double-tap on submit still inserts exactly one lead');
    const gl = s.ev('generate_lead');
    ok(gl.length === 1, 'GA4 generate_lead fires exactly once');
    ok(s.leadFbq().length === 1, 'Meta Lead fires exactly ONCE');
    const id = '00000000-0000-4000-8000-000000000001';
    ok(gl[0].params.event_id === id && s.leadFbq()[0][3] && s.leadFbq()[0][3].eventID === id, 'GA4 generate_lead and Meta Lead share the SAME event_id (the lead id)');
    const idxGL = s.gtagCalls.findIndex((c) => c.name === 'generate_lead');
    const idxThanks = s.gtagCalls.findIndex((c) => c.name === 'router_step_view' && c.params.step === 'f-thanks');
    ok(idxGL >= 0 && idxThanks > idxGL, 'the conversion fires BEFORE the thank-you view (generate_lead at ' + idxGL + ', f-thanks view at ' + idxThanks + ')');
    ok(s.redirects.length === 0 && s.fakeWindow.location.href === PAGE_URL, 'no redirect has happened yet when the conversion is counted (location is still the /start page)');
    ok(s.ev('router_contact_submitted').length === 1 && s.ev('router_contact_submitted')[0].params.step === 'f-contact' && s.ev('router_contact_submitted')[0].params.step_index === 3,
      'router_contact_submitted fires once {f-contact, step_index 3}');
    const thanks = s.ev('router_step_view').filter((e) => e.params.step === 'f-thanks');
    ok(thanks.length === 1 && thanks[0].params.step_index === 4, 'the thank-you screen fires router_step_view {f-thanks, step_index 4}');
    ok(s.ev('router_step_complete').filter((e) => e.params.step === 'f-contact').length === 1 && s.ev('router_step_complete').find((e) => e.params.step === 'f-contact').params.step_index === 3,
      'router_step_complete for f-contact carries step_index 3 (the #2096 CLOSE-REVIEW defect class)');
  }

  // ═══ F8: NEGATIVE CONTROL -- a failed insert counts nothing, shows the approved error, and a retry counts once. ═══
  {
    const s = buildF({ insertFails: 1 });
    drive(s, GOOD);
    submit(s); await settleN(3);
    ok(s.insertCalls.length === 1 && s.ev('generate_lead').length === 0 && s.leadFbq().length === 0 && s.ev('router_contact_submitted').length === 0,
      'NEGATIVE CONTROL: a failed insert fires NO generate_lead, NO Meta Lead, NO router_contact_submitted');
    ok(s.rpcCalls.length === 0, 'a failed insert never calls set_lead_role');
    ok(flatten(s.root).some((c) => c.textContent === COPY.arm_f_error_generic), 'a failed insert shows the approved generic error');
    ok(!buttonByText(s.root, COPY.arm_f_s3_button_submit).disabled, 'the submit button is re-enabled for a retry');
    ok(s.ev('router_step_view').filter((e) => e.params.step === 'f-thanks').length === 0, 'no thank-you screen after a failed save');
    submit(s); await settleN(3);
    ok(s.insertCalls.length === 2 && s.ev('generate_lead').length === 1 && s.leadFbq().length === 1, 'the retry succeeds and counts exactly one conversion');
  }

  // ═══ F9: set_lead_role error / hang never blocks the thank-you screen or loses the count. ═══
  {
    const e = buildF({ roleMode: 'error' }); drive(e, GOOD); submit(e); await settleN(4);
    await new Promise((r) => setTimeout(r, 200));
    ok(e.ev('router_step_view').some((v) => v.params.step === 'f-thanks') && e.leadFbq().length === 1, 'set_lead_role returning an error still reaches the thank-you screen with one Lead');
    const h = buildF({ roleMode: 'hang' }); drive(h, GOOD); submit(h); await settleN(3);
    ok(h.leadFbq().length === 1 && h.ev('generate_lead').length === 1, 'set_lead_role hanging does not delay the conversion count');
    await new Promise((r) => setTimeout(r, 300));
    ok(h.detailsCalls.length === 1, 'a hung set_lead_role does not delay the details/consent call at all: it started immediately');
    ok(h.ev('router_step_view').some((v) => v.params.step === 'f-thanks'), 'a hung set_lead_role falls through to the thank-you screen after the guard timeout');
  }

  // ═══ F10: thank-you screen -- copy, business-hours promise, two deep links, no second conversion. ═══
  {
    function thanks(nowIso, lead) { const s = buildF({ nowIso }); drive(s, lead || CALLABLE); submit(s); return settleN(4).then(() => s); }
    const inWin = await thanks('2026-09-23T15:00:00Z'); // 11:00 Indianapolis
    const t1 = flatten(inWin.root).map((c) => c.textContent);
    ok(t1.indexOf(COPY.arm_f_s4_headline) !== -1 && t1.indexOf(COPY.arm_f_s4_body_in_window) !== -1 && t1.indexOf(COPY.arm_f_s4_body_after_hours) === -1, 'inside 8am-8pm the in-window body shows and the after-hours body does not');
    const early = await thanks('2026-09-23T12:00:00Z'); // 08:00 boundary, inclusive
    ok(flatten(early.root).some((c) => c.textContent === COPY.arm_f_s4_body_in_window), '08:00 is inside the window (inclusive)');
    const late = await thanks('2026-09-24T00:00:00Z'); // 20:00 boundary, exclusive
    ok(flatten(late.root).some((c) => c.textContent === COPY.arm_f_s4_body_after_hours) && !flatten(late.root).some((c) => c.textContent === COPY.arm_f_s4_body_in_window), '20:00 is after hours (exclusive): the after-hours body shows');
    const night = await thanks('2026-09-24T02:00:00Z'); // 22:00
    ok(flatten(night.root).some((c) => c.textContent === COPY.arm_f_s4_body_after_hours), '22:00 shows the after-hours body');
    const btns = buttons(inWin.root).map((b) => b.textContent);
    ok(JSON.stringify(btns) === JSON.stringify([COPY.arm_f_s4_button_measure, COPY.arm_f_s4_button_losssheet]), 'the thank-you screen has exactly the two approved buttons');
    const before = inWin.leadFbq().length;
    buttonByText(inWin.root, COPY.arm_f_s4_button_measure).dispatchClick();
    const href = inWin.fakeWindow.location.href;
    ok(/^https:\/\/app\.otterquote\.com\/help-measurements\?lead=00000000-0000-4000-8000-000000000001/.test(href) && href.indexOf('v=f') !== -1, 'the $15 button deep-links to the existing /help-measurements with lead + attribution (' + href + ')');
    ok(inWin.leadFbq().length === before && inWin.ev('generate_lead').length === 1, 'clicking a deep link does NOT count a second conversion');
    const cta = inWin.ev('router_f_cta_measure');
    ok(cta.length === 1 && cta[0].params.step === 'f-thanks' && cta[0].params.step_index === 4 && cta[0].params.variant === 'f' && !('cta' in cta[0].params),
      'the click fires router_f_cta_measure {f-thanks, 4, variant f} -- the choice is in the event NAME, with no extra parameter');
    const ls = await thanks('2026-09-23T15:00:00Z');
    buttonByText(ls.root, COPY.arm_f_s4_button_losssheet).dispatchClick();
    ok(/^https:\/\/app\.otterquote\.com\/help-estimate\?lead=/.test(ls.fakeWindow.location.href), 'the loss-sheet button deep-links to the existing /help-estimate with the lead id');
    ok(ls.ev('router_f_cta_loss_sheet').length === 1, 'the loss-sheet click fires router_f_cta_loss_sheet');
    // The #2127 review found the F15 key allow-list ran BEFORE any CTA click, so it could not see these events.
    const ctaKeys = new Set(); [...inWin.gtagCalls, ...ls.gtagCalls].forEach((c) => Object.keys(c.params || {}).forEach((k) => ctaKeys.add(k)));
    const allowedAfterCta = new Set(['step', 'step_index', 'variant', 'ua_context', 'lead_id', 'event_id']);
    ok([...ctaKeys].every((k) => allowedAfterCta.has(k)), 'AFTER the CTA clicks every GA4 parameter key is still one of variant / step / step_index / ua_context / lead_id / event_id (unexpected: ' + [...ctaKeys].filter((k) => !allowedAfterCta.has(k)).join(',') + ')');
  }

  // ═══ F10b (LEGAL-READ B1, D-299 / D-332; Dustin's rulings 5804614805): a lead with NO phone gets the approved no-call
  // line; a lead WITH a phone gets the call variants whether or not the box is ticked (a manual human call to an inbound
  // lead is permitted; the box governs autodialer / prerecorded / text, which is the dialer's job, not this screen's). ═══
  {
    const NOCALL = COPY.arm_f_s4_confirm_email_only;
    const promises = (s) => flatten(s.root).some((c) => c.textContent === COPY.arm_f_s4_body_in_window || c.textContent === COPY.arm_f_s4_body_after_hours);
    const says = (s, t) => flatten(s.root).some((c) => c.textContent === t);
    async function shown(lead, nowIso) { const s = buildF({ nowIso: nowIso || '2026-09-23T15:00:00Z' }); drive(s, lead); submit(s); await settleN(4); return s; }
    ok(NOCALL === APPROVED_NOCALL, 'the no-call line is BYTE-IDENTICAL to the approved string (ARM F COPY -- APPROVED, no-call variant)');
    ok(NOCALL !== COPY.arm_f_s4_body_in_window && NOCALL !== COPY.arm_f_s4_body_after_hours, 'the no-call line is a distinct string from both call variants');
    const emailOnly = await shown({ name: 'Jane', phone: '', email: 'jane@example.com', consent: false });
    ok(!promises(emailOnly) && says(emailOnly, NOCALL), 'B1: NO phone (email only, box unticked) -> NO call promise; the approved no-call line shows');
    const emailOnlyTicked = await shown({ name: 'Jane', phone: '', email: 'jane@example.com', consent: true });
    ok(!promises(emailOnlyTicked) && says(emailOnlyTicked, NOCALL), 'B1: NO phone but the box ticked (nothing to call) -> NO call promise');
    const phoneUnticked = await shown({ name: 'Jane', phone: '(317) 255-0142', email: 'jane@example.com', consent: false });
    ok(says(phoneUnticked, COPY.arm_f_s4_body_in_window) && !says(phoneUnticked, NOCALL), "phone typed, box UNTICKED -> the call variant (Dustin: a human call to an inbound lead who gave a number is permitted without the box)");
    const phoneUntickedLate = await shown({ name: 'Jane', phone: '(317) 255-0142', email: 'jane@example.com', consent: false }, '2026-09-24T02:00:00Z');
    ok(says(phoneUntickedLate, COPY.arm_f_s4_body_after_hours) && !says(phoneUntickedLate, NOCALL), 'phone typed, box unticked, after hours -> the after-hours call variant');
    const phoneOnlyUnticked = await shown({ name: 'Jane', phone: '(317) 255-0142', email: '', consent: false });
    ok(says(phoneOnlyUnticked, COPY.arm_f_s4_body_in_window), 'phone only (no email), box unticked -> the call variant');
    const callable = await shown(CALLABLE);
    ok(says(callable, COPY.arm_f_s4_body_in_window) && !says(callable, NOCALL), 'phone + ticked box, in the window -> the in-window call variant');
    const callableLate = await shown(CALLABLE, '2026-09-24T02:00:00Z');
    ok(says(callableLate, COPY.arm_f_s4_body_after_hours) && !says(callableLate, NOCALL), 'phone + ticked box, after hours -> the after-hours call variant');
    // the screen choice changes what is SHOWN, never what is stored or counted, and the box is never presumed ticked
    ok(emailOnly.detailsCalls.length === 1 && emailOnly.detailsCalls[0].body.consent.given === false, 'the consent record is still written for a no-phone lead (given:false)');
    ok(phoneUnticked.detailsCalls[0].body.consent.given === false, 'an unticked box is STILL recorded given:false even though the screen shows the call variant (no dialer may ever treat this lead as consented)');
    ok(emailOnly.ev('generate_lead').length === 1, 'a no-call lead still counts exactly one conversion');
    ok(JSON.stringify(buttons(emailOnly.root).map((b) => b.textContent)) === JSON.stringify([COPY.arm_f_s4_button_measure, COPY.arm_f_s4_button_losssheet]), 'the two CTA buttons still show for a no-call lead');
    ok(RVF_NO_DRAFT(), 'no DRAFT_COPY block remains: the no-call line is in the one approved constants block');
    function RVF_NO_DRAFT() { const s = buildF(); return s.RVF.DRAFT_COPY === undefined; }
  }

  // ═══ F11: abandonment. Before the save a pagehide IS an abandon; after the save it is NOT. Negative control removes the guard. ═══
  {
    const pre = buildF();
    pickFunding(pre, COPY.arm_f_s1_option_cash); // now on f-address
    pre.firePagehide();
    const ab = pre.ev('router_step_abandoned');
    ok(ab.length === 1 && ab[0].params.step === 'f-address' && ab[0].params.step_index === 2 && ab[0].params.variant === 'f' && ab[0].params.ua_context === 'other',
      'a pagehide on screen 2 fires router_step_abandoned {f-address, 2, variant f, ua_context} -- the drop-off layer works for F');
    const post = buildF(); drive(post, GOOD); submit(post); await settleN(4);
    post.firePagehide();
    ok(post.ev('router_step_abandoned').length === 0, 'after the lead is saved a pagehide fires NO router_step_abandoned (thank-you is not a drop-off)');
    const ctl = buildF({ noSuppress: true }); drive(ctl, GOOD); submit(ctl); await settleN(4);
    ctl.firePagehide();
    ok(ctl.ev('router_step_abandoned').length === 1 && ctl.ev('router_step_abandoned')[0].params.step === 'f-thanks',
      'NEGATIVE CONTROL: with markLeadSaved() removed the false router_step_abandoned{f-thanks} DOES fire, so the suppression above is what prevents it');
  }

  // ═══ F13: the details + consent call -- exact body, byte-identical consent, server-bound only. ═══
  {
    const s = buildF({ ua: FB_UA });
    drive(s, { name: 'Jane', phone: '(317) 255-0142', email: 'jane@example.com', consent: true, address: '123 Main St, Indianapolis, IN 46204' }, COPY.arm_f_s1_option_insurance);
    submit(s); await settleN(4);
    ok(s.detailsCalls.length === 1 && s.detailsCalls[0].name === 'record-lead-details', 'exactly one call to the record-lead-details Edge Function on success');
    const b = s.detailsCalls[0] && s.detailsCalls[0].body;
    ok(!!b && b.lead_id === '00000000-0000-4000-8000-000000000001', 'the body carries the saved lead id');
    ok(b.funding_type === 'insurance' && b.property_address === '123 Main St, Indianapolis, IN 46204', 'the body carries the funding answer and the address');
    ok(b.fbc === 'fb.1.1700000000.cookieFbc' && b.fbp === 'fb.1.1700000000.cookieFbp', 'the body carries fbc and fbp from the Meta cookies');
    ok(b.consent && b.consent.key === 'arm_f_s3_consent_checkbox' && b.consent.given === true && b.consent.text === APPROVED_CONSENT,
      'the consent record is {key arm_f_s3_consent_checkbox, given true, text BYTE-IDENTICAL to the approved draft}');
    ok(b.page_url === PAGE_URL, 'the body carries the page URL');
    ok(JSON.stringify(b.submitted_fields) === JSON.stringify(['name', 'phone', 'email', 'address', 'funding']), 'the body lists which fields were submitted (no values)');
    ok(!('ip' in b) && !('user_agent' in b), 'the client sends NO ip or user_agent: the Edge Function observes them itself');
    ok(b.phone_as_typed === '(317) 255-0142', 'D-299: the body carries the phone AS TYPED, before normalisation (' + JSON.stringify(b.phone_as_typed) + ')');
    ok(b.form_payload && b.form_payload.name === 'Jane' && b.form_payload.phone === '(317) 255-0142' && b.form_payload.email === 'jane@example.com' && b.form_payload.address === '123 Main St, Indianapolis, IN 46204' && b.form_payload.funding_type === 'insurance',
      'D-299: the body carries the form payload -- the submitted VALUES (name, phone as typed, email, address, funding)');
    const call = s.detailsCalls[0];
    ok(call.init.keepalive === true && call.init.method === 'POST', 'the details request is a keepalive POST (the browser lets it finish after the page is gone)');
    ok(Object.keys(call.init.headers).join() === 'Content-Type' && /^text\/plain/.test(call.init.headers['Content-Type']), 'it is a SIMPLE request: Content-Type text/plain and NO custom header, so there is no CORS preflight to fail during unload');
    ok(/^https:\/\/proj\.supabase\.co\/functions\/v1\/record-lead-details\?apikey=anon-key-123$/.test(call.url), 'the anon key rides as a query parameter (a header would force a preflight): ' + call.url);
    ok(!/Authorization|apikey/i.test(JSON.stringify(call.init.headers)), 'no Authorization or apikey header is sent');
    ok(s.sentry.length === 0, 'no Sentry report on success');
    const u = buildF({ ua: FB_UA }); drive(u, { name: 'Jane', phone: '(317) 255-0142', email: '', consent: false }); submit(u); await settleN(4);
    ok(u.detailsCalls[0].body.consent.given === false && u.detailsCalls[0].body.consent.text === APPROVED_CONSENT, 'an UNTICKED box is recorded as given:false with the same exact text (evidence of what was displayed)');
    ok(JSON.stringify(u.detailsCalls[0].body.submitted_fields) === JSON.stringify(['name', 'phone', 'address', 'funding']), 'phone-only: email is not listed as submitted');
    const nocookie = buildF({ cookie: '' }); drive(nocookie, GOOD); submit(nocookie); await settleN(4);
    ok(/^fb\.1\.\d+\.IwAR123$/.test(nocookie.detailsCalls[0].body.fbc) && nocookie.detailsCalls[0].body.fbp === null, 'with no _fbc cookie, fbc is derived from the fbclid in the URL; a missing _fbp is null');
  }

  // ═══ F14: ONE retry, then Sentry (lead id only); never blocks; never a second conversion. ═══
  {
    const once = buildF({ detailsMode: 'fail-once' }); drive(once, GOOD); submit(once); await settleN(4);
    await new Promise((r) => setTimeout(r, 100));
    ok(once.detailsCalls.length === 2 && once.sentry.length === 0, 'a first failure is retried once; the retry succeeds and nothing is reported');
    const bad = buildF({ detailsMode: 'fail-always' }); drive(bad, GOOD); submit(bad); await settleN(4);
    await new Promise((r) => setTimeout(r, 200));
    ok(bad.detailsCalls.length === 2, 'a persistent failure makes exactly TWO calls (one retry, not a loop)');
    ok(bad.sentry.length === 1 && /record-lead-details failed after 2 attempt/.test(bad.sentry[0].msg), 'the final failure is reported to Sentry once: "' + (bad.sentry[0] && bad.sentry[0].msg) + '"');
    const rep = JSON.stringify(bad.sentry);
    ok(rep.indexOf('Main St') === -1 && rep.indexOf('autodialer') === -1 && rep.indexOf('jane@example.com') === -1 && rep.indexOf('317') === -1 && rep.indexOf('insurance') === -1,
      'the Sentry report carries NO address, consent text, email, phone or funding answer');
    ok(bad.sentry[0].ctx.extra.lead_id === '00000000-0000-4000-8000-000000000001', 'the Sentry report carries the lead id');
    ok(bad.ev('router_step_view').some((v) => v.params.step === 'f-thanks'), 'a failing details call does NOT block the thank-you screen');
    ok(bad.ev('generate_lead').length === 1 && bad.leadFbq().length === 1, 'a failing details call does not count a second conversion or lose the first');
    const oos = buildF({ detailsMode: 'out-of-scope' }); drive(oos, GOOD); submit(oos); await settleN(4);
    await new Promise((r) => setTimeout(r, 100));
    ok(oos.detailsCalls.length === 1 && oos.sentry.length === 1, 'lead_out_of_scope is NOT retried (it cannot succeed) but is reported');
    const notok = buildF({ detailsMode: 'notok' }); drive(notok, GOOD); submit(notok); await settleN(4);
    await new Promise((r) => setTimeout(r, 200));
    ok(notok.detailsCalls.length === 2 && notok.sentry.length === 1, 'an ok:false response is treated as a failure: retried once, then reported');
    const hang = buildF({ detailsMode: 'hang' }); drive(hang, GOOD); submit(hang); await settleN(4);
    await new Promise((r) => setTimeout(r, 200));
    ok(hang.ev('router_step_view').some((v) => v.params.step === 'f-thanks'), 'a HUNG details call falls through to the thank-you screen after the flow guard');
    const failInsert = buildF({ insertFails: 1 }); drive(failInsert, GOOD); submit(failInsert); await settleN(4);
    ok(failInsert.detailsCalls.length === 0, 'NEGATIVE CONTROL: a failed insert makes NO details call (there is no lead to attach it to)');
  }

  // ═══ F15: PII ban -- nothing personal or funding-related in ANY analytics call. ═══
  {
    const s = buildF({ ua: FB_UA });
    drive(s, { name: 'Jane', phone: '(317) 255-0142', email: 'jane@example.com', consent: true, address: '123 Main St, Indianapolis, IN 46204' }, COPY.arm_f_s1_option_insurance);
    submit(s); await settleN(4);
    const everything = JSON.stringify([s.gtagCalls, s.fbqCalls, s.clarityCalls]);
    const banned = ['Main St', '46204', 'Jane', 'jane@example.com', '2550142', 'autodialer', 'call or text', 'cookieFbc', 'cookieFbp', 'IwAR123'];
    const leaked = banned.filter((t) => everything.indexOf(t) !== -1);
    ok(leaked.length === 0, 'no address, name, email, phone, consent text, fbc/fbp or fbclid in any GA4, Meta or Clarity call (leaked: ' + leaked.join(',') + ')');
    const keys = new Set(); s.gtagCalls.forEach((c) => Object.keys(c.params || {}).forEach((k) => keys.add(k)));
    const allowed = new Set(['step', 'step_index', 'variant', 'ua_context', 'lead_id', 'event_id']);
    const extra = [...keys].filter((k) => !allowed.has(k));
    ok(extra.length === 0, 'every GA4 parameter is one of variant / step / step_index / ua_context / lead_id / event_id (unexpected: ' + extra.join(',') + ')');
    ok(!keys.has('funding_type') && !keys.has('consent_given'), 'no funding_type and no consent_given parameter on any event');
    ok(s.fbqCalls.every((c) => JSON.stringify(c).indexOf('insurance') === -1 && JSON.stringify(c.slice(2)) !== undefined) && s.leadFbq()[0].length === 4 && Object.keys(s.leadFbq()[0][2]).length === 0,
      'the Meta Lead call carries an EMPTY parameter object and only an eventID option');
  }

  // ═══ F16: set_lead_role is retried once and reported (the #1932 alert only fires when it succeeds). ═══
  {
    const once = buildF({ roleMode: 'fail-once' }); drive(once, GOOD); submit(once); await settleN(4);
    await new Promise((r) => setTimeout(r, 200));
    ok(once.rpcCalls.filter((c) => c.name === 'set_lead_role').length === 2 && once.sentry.length === 0, 'a failing set_lead_role is retried once; the retry succeeds and nothing is reported');
    const bad = buildF({ roleMode: 'error' }); drive(bad, GOOD); submit(bad); await settleN(4);
    await new Promise((r) => setTimeout(r, 300));
    ok(bad.rpcCalls.filter((c) => c.name === 'set_lead_role').length === 2, 'a persistent set_lead_role failure makes exactly TWO calls (one retry, not a loop)');
    const roleReport = bad.sentry.find((r) => /set_lead_role/.test(r.msg));
    ok(!!roleReport && /failed after 2 attempt/.test(roleReport.msg) && /alert will not fire/.test(roleReport.msg), 'the final set_lead_role failure is reported to Sentry, naming the consequence: "' + (roleReport && roleReport.msg) + '"');
    ok(roleReport.ctx.extra.lead_id === '00000000-0000-4000-8000-000000000001' && JSON.stringify(roleReport).indexOf('Main St') === -1 && JSON.stringify(roleReport).indexOf('jane@example.com') === -1, 'the role report carries the lead id and no personal data');
    ok(bad.detailsCalls.length >= 1 && bad.ev('router_step_view').some((v) => v.params.step === 'f-thanks'), 'a failing set_lead_role does not stop the details call or block the thank-you screen');
    ok(bad.ev('generate_lead').length === 1 && bad.leadFbq().length === 1, 'a failing set_lead_role does not lose or double the conversion');
    const falseRes = buildF({ roleMode: 'false' }); drive(falseRes, GOOD); submit(falseRes); await settleN(4);
    await new Promise((r) => setTimeout(r, 300));
    ok(falseRes.rpcCalls.filter((c) => c.name === 'set_lead_role').length === 2 && falseRes.sentry.some((r) => /set_lead_role/.test(r.msg)),
      'set_lead_role returning FALSE (the RPC no-op) is treated as a failure: retried once, then reported');
  }

  // ═══ F17: a SYNCHRONOUS throw from insertFreshLead must not strand the visitor. ═══
  {
    const t = buildF({ insertThrows: true }); drive(t, GOOD); submit(t); await settleN(4);
    ok(flatten(t.root).some((c) => c.textContent === COPY.arm_f_error_generic), 'a synchronous throw from insertFreshLead shows the approved generic error');
    ok(!buttonByText(t.root, COPY.arm_f_s3_button_submit).disabled, 'the submit button is re-enabled after a synchronous throw (it stayed disabled forever before this fix)');
    ok(t.ev('generate_lead').length === 0 && t.leadFbq().length === 0 && t.detailsCalls.length === 0 && t.rpcCalls.length === 0, 'a synchronous throw counts no conversion and makes no details or role call');
  }

  // ═══ F18: Clarity masking, the CSS that makes the headlines visible, and the midnight / missing-Intl business-hours cases. ═══
  {
    const s = buildF();
    ok(s.root.getAttribute('data-clarity-mask') === 'true', 'the arm root carries data-clarity-mask="true" (the funding answer is a button label; screens 2-3 hold an address and contact details)');
    const css = startSrc.slice(startSrc.indexOf('<style'), startSrc.indexOf('</style>'));
    const headRule = /([^{}]*#routerFRoot h1[^{}]*)\{([^}]*)\}/.exec(css);
    ok(!!headRule && /color:\s*var\(--white\)/.test(headRule[2]), 'start.html has a rule for #routerFRoot h1 that sets color: var(--white) (the page h1 default is the navy page background: invisible headlines)');
    const subRule = /([^{}]*#routerFRoot p\.router-sub[^{}]*)\{([^}]*)\}/.exec(css);
    ok(!!subRule && /color:\s*var\(--slate\)/.test(subRule[2]), 'start.html styles #routerFRoot p.router-sub like C and D (readable subheads)');
    ok((css.match(/#routerFRoot h1/g) || []).length >= 2, "the mobile (max-width) heading rule also covers #routerFRoot h1");
    ok(/#routerFRoot p\.router-sub a\s*\{[^}]*color:/.test(css), 'the privacy / terms links have an explicit colour on the dark card');
    ok(/#routerFRoot \.rf-consent\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*row/.test(css), 'the consent row is a flex ROW (flex-direction: row overrides the shared .form-group column): the checkbox sits beside its wrapped label');
    ok(/#routerFRoot \.rf-consent label\s*\{[^}]*text-transform:\s*none/.test(css), 'the consent label is NOT uppercased (the design system .form-label uppercases; the legal sentence must render as written)');
    const c3 = buildF(); drive(c3, GOOD);
    ok(/(^| )rf-consent( |$)/.test(byId(c3.root, 'rfConsent').parentNode.className), 'the consent checkbox sits inside the .rf-consent flex row the CSS targets');
    const mid = buildF({ Intl: { DateTimeFormat: function () { return { formatToParts: () => [{ type: 'hour', value: '24' }] }; } } });
    drive(mid, CALLABLE); submit(mid); await settleN(4);
    ok(flatten(mid.root).some((c) => c.textContent === COPY.arm_f_s4_body_after_hours), 'an engine that reports midnight as "24" gets the AFTER-HOURS copy');
    const noIntl = buildF({ Intl: null }); drive(noIntl, CALLABLE); submit(noIntl); await settleN(4);
    ok(flatten(noIntl.root).some((c) => c.textContent === COPY.arm_f_s4_body_after_hours), 'with NO Intl available the AFTER-HOURS copy is shown (the promise that is never wrong)');
  }

  // ═══ F19: a thank-you button must not abort a details call that is still in flight; Back is locked during the save. ═══
  {
    const h = buildF({ detailsMode: 'hang' }); drive(h, GOOD); submit(h); await settleN(3);
    await new Promise((r) => setTimeout(r, 90)); // the flow guard (6s, scaled) shows the thank-you screen while details hang
    ok(h.ev('router_step_view').some((v) => v.params.step === 'f-thanks') && h.detailsCalls.length >= 1, 'setup: the thank-you screen is showing while the details call is still in flight');
    buttonByText(h.root, COPY.arm_f_s4_button_measure).dispatchClick();
    ok(h.fakeWindow.location.href === PAGE_URL && h.ev('router_f_cta_measure').length === 1, 'a CTA tap does NOT navigate while details are in flight (it would abort the request), but the click is still counted');
    await new Promise((r) => setTimeout(r, 80)); // CTA_WAIT_MS (2.5s, scaled) elapses
    ok(/^https:\/\/app\.otterquote\.com\/help-measurements\?lead=/.test(h.fakeWindow.location.href), 'after the wait cap the CTA navigates anyway (a hung request never strands the visitor)');
    const k = buildF({ detailsMode: 'ok' }); drive(k, GOOD); submit(k); await settleN(4);
    await new Promise((r) => setTimeout(r, 60));
    buttonByText(k.root, COPY.arm_f_s4_button_losssheet).dispatchClick();
    ok(/help-estimate\?lead=/.test(k.fakeWindow.location.href), 'when the details call has already settled a CTA tap navigates immediately');
    const b = buildF({ insertFails: 1 }); drive(b, GOOD);
    const backOf = (x) => buttons(x.root).find((y) => y.textContent === '← Back');
    ok(backOf(b) && backOf(b).disabled !== true, 'setup: Back is enabled on screen 3 before submit');
    submit(b);
    ok(backOf(b).disabled === true, 'Back is DISABLED as soon as the save starts');
    await settleN(4);
    ok(backOf(b).disabled === false, 'Back is re-enabled after a failed save (the visitor can still correct the address)');
  }

  // ═══ F20: D-299 -- the details request starts immediately and survives a closed tab. ═══
  {
    const a = buildF({ detailsMode: 'hang', roleMode: 'hang' }); drive(a, GOOD); submit(a); await settle(); await settle();
    ok(a.detailsCalls.length === 1 && a.order[0] === 'insert' && a.order[1] === 'details', 'the details request is sent in the same tick the insert resolves, with no wait and while set_lead_role is still pending: ' + a.order.join(' > '));
    ok(a.beacons.length === 0, 'no beacon while the page is still open');
    ok(a.rpcCalls.filter((c) => c.name === 'set_lead_role').length === 1 && a.order.indexOf('set_lead_role') !== -1, 'set_lead_role starts IN PARALLEL with a hung details call (a chained implementation would silently drop the #1932 alert until the guard)');
    a.firePagehide();
    ok(a.beacons.length === 1, 'a pagehide right after the insert, with the write not yet confirmed, sends the details as a beacon');
    const bc = a.beacons[0];
    const text = await bc.blob.text();
    const parsed = JSON.parse(text);
    ok(/^https:\/\/proj\.supabase\.co\/functions\/v1\/record-lead-details\?apikey=anon-key-123$/.test(bc.url) && /^text\/plain/.test(bc.blob.type), 'the beacon goes to the same URL as a text/plain body (a simple request: no preflight)');
    ok(parsed.lead_id === '00000000-0000-4000-8000-000000000001' && parsed.consent.text === APPROVED_CONSENT && parsed.consent.key === 'arm_f_s3_consent_checkbox' && parsed.phone_as_typed === '(317) 255-0142' && parsed.form_payload.address === '123 Main St, Indianapolis, IN 46204',
      'the beacon carries the SAME full body: lead id, the byte-identical consent record, the phone as typed and the form payload');
    a.firePagehide();
    ok(a.beacons.length === 1, 'a second pagehide does not send a second beacon');

    const c = buildF({ detailsMode: 'ok' }); drive(c, GOOD); submit(c); await settleN(4);
    await new Promise((r) => setTimeout(r, 50));
    c.firePagehide();
    ok(c.beacons.length === 0, 'once the write is CONFIRMED a pagehide sends no beacon');

    const v = buildF({ detailsMode: 'hang' }); drive(v, GOOD); submit(v); await settle();
    v.fireVisibilityHidden();
    ok(v.beacons.length === 1, 'the page being hidden (mobile browsers that skip pagehide) also sends the beacon when the write is unconfirmed');

    const f = buildF({ detailsMode: 'fail-always' }); drive(f, GOOD); submit(f); await settleN(4);
    await new Promise((r) => setTimeout(r, 100));
    f.firePagehide();
    ok(f.detailsCalls.length === 2 && f.beacons.length === 1, 'after a failed write and its retry, a pagehide gets one last beacon attempt');

    const pre = buildF({ detailsMode: 'hang' }); drive(pre, GOOD);
    pre.firePagehide();
    ok(pre.beacons.length === 0 && pre.detailsCalls.length === 0, 'NEGATIVE CONTROL: a pagehide BEFORE the lead is saved sends nothing (there is no lead to attach a consent record to)');

    const bf = buildF({ detailsMode: 'hang', beaconFails: true }); drive(bf, GOOD); submit(bf); await settle(); await settle();
    bf.firePagehide(); bf.firePagehide();
    ok(bf.beacons.length === 2, 'when sendBeacon returns FALSE (queue full) the beacon stays retryable: a second pagehide tries again');
    const once = buildF({ detailsMode: 'ok' }); drive(once, GOOD); submit(once); await settleN(4);
    await new Promise((r) => setTimeout(r, 120)); // well past the flow guard (6 s scaled to 60 ms)
    ok(once.ev('router_step_view').filter((e) => e.params.step === 'f-thanks').length === 1, 'the thank-you screen is shown exactly ONCE even though both the settle path and the flow guard fire (finish is idempotent)');
    const longUrl = buildF({ detailsMode: 'ok' }); longUrl.fakeWindow.location.href = 'https://otterquote.com/start?v=f&x=' + 'y'.repeat(5000);
    drive(longUrl, GOOD); submit(longUrl); await settleN(4);
    ok(longUrl.detailsCalls[0].body.page_url.length === 2000, 'page_url is capped at 2000 characters client-side (an over-long URL cannot push the keepalive body past its size limit)');
    const nf = buildF({ noFetch: true }); drive(nf, GOOD); submit(nf); await settleN(4);
    ok(nf.detailsCalls.length === 1 && nf.detailsCalls[0].name === 'record-lead-details' && nf.detailsCalls[0].init === undefined, 'with no fetch or no URL the module falls back to the supabase-js invoke path (and still sends the details)');
  }

  // ═══ F12: routing and reachability guards read out of the REAL start.html head script. ═══
  ok(/var KNOWN_ARMS = \['a', 'b', 'c', 'd', 'e', 'f'\];/.test(startSrc), "start.html KNOWN_ARMS recognises 'f' so ?v=f parses");
  const live = /var LIVE_VARIANTS = (\[[^\]]*\]);/.exec(startSrc);
  ok(live && new Function('return ' + live[1])().indexOf('f') === -1, "'f' is NOT in LIVE_VARIANTS: it is not in the random split until Sloane says so on #2122");
  // gh-2121 (LRS S05): converted from eager object-literal properties to getters
  // so config.js can be `defer`red without a race -- js/router-variant-f.js's own
  // detailsUrl()/anonKey reads (see F5 above) are already call-time, not
  // init-time, so this is a syntax change only; same CONFIG.SUPABASE_URL /
  // CONFIG.SUPABASE_ANON source, same fallback to null when CONFIG isn't ready.
  ok(/get detailsUrl\(\) \{ return \(typeof CONFIG !== 'undefined' && CONFIG\.SUPABASE_URL\)/.test(startSrc) && /get anonKey\(\) \{ return \(typeof CONFIG/.test(startSrc), "start.html's F bridge supplies the Edge Function URL and the public anon key");
  ok(startSrc.indexOf('id="routerFRoot"') !== -1 && startSrc.indexOf("routerFScript.src = 'js/router-variant-f.js'") !== -1, 'start.html mounts #routerFRoot and loads js/router-variant-f.js only inside the ARM_F branch');
  ok(/if \(ARM_C \|\| ARM_D \|\| ARM_E \|\| ARM_F\) return;/.test(startSrc), 'renderStep early-returns for arm F like C/D/E (A/B shared-section code never runs over F)');

  console.log('\n=== Summary ===\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('UNCAUGHT:', e); process.exit(1); });
