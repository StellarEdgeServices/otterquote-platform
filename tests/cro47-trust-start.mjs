/**
 * gh-2362 (CRO47 spec cro47-trustspec-20260929, section 2.5; Ben's Tier B ruling on #2121, comment 5895347981):
 * /start Arm F trust header + the address is asked AFTER contact.
 *
 * Acceptance tests T2-T9 and negative controls N1-N5, written to the spec's own definitions. T1 (the real-Chromium
 * phone-viewport proof in a Facebook in-app UA) is tests/cro47-trust-start-playwright.mjs; this file holds the static half
 * of T1 (markup, copy, asset, scoping) and everything that runs in the Node vm harness.
 *
 * Harness: the REAL js/router-variant-f.js runs in a Node `vm` context behind a minimal DOM shim, together with the REAL
 * start.html blocks (trackRouter, collectAttribution, insertFreshLead, markLeadSaved, the abandon beacon) extracted by anchor
 * text at run time -- never hand-retyped. So the leads insert payload, the utm/fbclid attribution, lead_id stamping and the
 * abandon suppression are asserted against start.html's own code. Same philosophy as tests/gh2122-arm-f.mjs (whose harness
 * this deliberately does not import: the mutation controls below need to rebuild the harness from MUTATED sources). This is
 * NOT a browser; T1's Playwright file is.
 *
 * Negative controls are automated mutations: each takes the real source, applies one mutation, re-runs the acceptance
 * checks, and requires the named test to go RED. A control that stays green means the test is not testing what it says.
 *
 * Run: node tests/cro47-trust-start.mjs      Exit 0 = all green (including every control going red), 1 = any failure.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const START = read('start.html');
const ROUTER = read('js/router-variant-f.js');
const PROFILE = read('partner-profile.html');
const md5 = (t) => crypto.createHash('md5').update(t, 'utf8').digest('hex');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; }
}

// ── Pinned strings ────────────────────────────────────────────────────────────────────────────────────────────
const APPROVED_CONSENT_MD5 = '8b70cec83a92d9787a4a527c0e5d2f89';
const APPROVED_PRIVACY = 'By continuing, you agree to our Privacy Policy and Terms.';
const NEW_CONTACT_HEADLINE = 'How should we reach you?'; // "Almost done — " deleted from the approved string, nothing else (Sloane, CRO RUN 47, Q6)
// Sloane's ruling (Q2): the who-we-are line is the live partner-profile.html sentence, byte-for-byte. Derived from that file,
// never retyped: the sentence spans two source lines and writes the dash as &mdash;.
const WHO_WE_ARE = (function () {
  const m = /Otter Quotes connects homeowners with multiple competing\s+contractor bids for their project &mdash; free, with no obligation\./.exec(PROFILE);
  if (!m) throw new Error('partner-profile.html who-we-are sentence not found (anchor moved)');
  return m[0].replace(/\s+/g, ' ').replace('&mdash;', '—');
})();

// ── Extraction from the real start.html (throws loudly if an anchor moved) ──────────────────────────────────────
function extractBetween(src, startAnchor, endAnchor, label) {
  const s = src.indexOf(startAnchor);
  if (s === -1) throw new Error('extraction anchor not found (start): ' + label);
  const e = src.indexOf(endAnchor, s);
  if (e === -1) throw new Error('extraction anchor not found (end): ' + label);
  return src.slice(s, e);
}
function blocksOf(startSrc) {
  return {
    attrKeys: extractBetween(startSrc, 'var ATTR_KEYS = [', '\n\n  // ── gh-2014: A/B/C front-door variant', 'ATTR_KEYS'),
    attr: extractBetween(startSrc, 'function cleanAttrValue(raw, max) {', '\n\n  // ── gh-2014: local event helper', 'cleanAttrValue..collectAttribution'),
    track: extractBetween(startSrc, 'var STEP_INDEX_AB = {', '\n\n  // ── Phone validation:', 'STEP_INDEX_AB..trackRouter'),
    redirect: extractBetween(startSrc, 'function redirectTo(dest, preBuilt) {', '\n\n  // gh-1994 fix round 2 (Ben, non-blocking item)', 'redirectTo'),
    insert: extractBetween(startSrc, 'var INSERT_EXTRA_COLUMNS = [', "\n\n  // ── gh-2016: arm B's entry screen", 'insertFreshLead'),
    markSaved: extractBetween(startSrc, 'function markLeadSaved() {', '\n\n', 'markLeadSaved'),
    abandon: extractBetween(startSrc, 'var ABANDON_HIDDEN_GRACE_MS = 5000;', "\n\n  // gh-2017: arm C's bridge, assembled LAST", 'abandon beacon')
  };
}

// ── Minimal DOM shim (same surface as tests/gh2122-arm-f.mjs) ───────────────────────────────────────────────────
function makeDom() {
  const registry = {};
  function dispatchDomEvent(target, type) {
    const event = { type, preventDefault() {}, stopPropagation() {} };
    (target._listeners[type] || []).forEach((entry) => entry.fn(event));
  }
  function createElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(), _classes: [], children: [], attributes: {}, style: {}, _listeners: {}, _text: '', parentNode: null,
      querySelectorAll(sel) {
        const s = String(sel || '').trim();
        if (s.charAt(0) !== '.') throw new Error('shim supports class selectors only: ' + sel);
        const out = [];
        (function walk(e) { (e.children || []).forEach((c) => { if ((c._classes || []).indexOf(s.slice(1)) !== -1) out.push(c); walk(c); }); })(this);
        return out;
      },
      click() { this.dispatchClick(); },
      get className() { return this._classes.join(' '); },
      set className(v) { this._classes = v ? String(v).split(/\s+/).filter(Boolean) : []; },
      get textContent() { return this.children.length ? this.children.map((c) => (c.textContent != null ? c.textContent : '')).join('') : this._text; },
      set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; },
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
    createElement, createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }), getElementById: (id) => registry[id] || null,
    visibilityState: 'visible', documentElement: createElement('html'),
    addEventListener(evt, fn) { (windowListeners[evt] = windowListeners[evt] || []).push(fn); }, body: { appendChild: (e) => e }
  };
  return { document, windowListeners };
}
function flatten(el) { const out = [el]; (el.children || []).forEach((c) => out.push(...flatten(c))); return out; }
const byId = (root, id) => flatten(root).find((c) => c.id === id);
const buttons = (root) => flatten(root).filter((c) => c.tagName === 'BUTTON');
const buttonByText = (root, text) => buttons(root).find((b) => b.textContent === text);
const settle = () => new Promise((r) => setImmediate(r));
async function settleN(n) { for (let i = 0; i < n; i++) await settle(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeFakeDate(fixedMs) {
  return class extends Date { constructor(...a) { if (a.length === 0) super(fixedMs); else super(...a); } static now() { return fixedMs; } };
}

const FB_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/450.0]';
const URL_BASE = 'https://otterquote.com/start?v=f&fbclid=T&utm_source=facebook&utm_campaign=ho-1';
const LEAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// opts: moduleSrc, startSrc, url, ua, cookie, insertFails (n), detailsMode ('ok' | 'fail-address')
function buildF(opts) {
  opts = opts || {};
  const startSrc = opts.startSrc || START;
  const B = blocksOf(startSrc);
  const url = opts.url || URL_BASE;
  const { document, windowListeners } = makeDom();
  const root = document.createElement('div');
  root.setAttribute('id', 'routerFRoot');
  const gtagCalls = []; const fbqCalls = []; const clarityCalls = []; const inserts = []; const rpcCalls = []; const detailsCalls = []; const sentry = [];
  const ctl = { insertFailsLeft: opts.insertFails || 0 };
  const search = url.slice(url.indexOf('?'));
  const fakeWindow = {
    location: { href: url, search }, addEventListener(evt, fn) { (windowListeners[evt] = windowListeners[evt] || []).push(fn); },
    crypto: { randomUUID: () => '11111111-2222-4333-8444-' + String(1000000000000 + inserts.length + 1).slice(1) }
  };
  fakeWindow.clarity = function () { clarityCalls.push([].slice.call(arguments)); };
  fakeWindow.Sentry = { captureMessage: (msg, c) => { sentry.push({ msg, ctx: c }); } };
  document.cookie = opts.cookie === undefined ? '' : opts.cookie;
  const beacons = [];
  const fetchStub = (u, init) => {
    const body = JSON.parse(init.body);
    detailsCalls.push({ url: u, init, body });
    const reply = (good, status, data) => { const p = Promise.resolve({ ok: good, status, json: () => Promise.resolve(data) }); return { then: (a, b) => p.then(a, b) }; };
    if (opts.detailsMode === 'fail-address' && body.property_address) return reply(false, 500, { ok: false });
    return reply(true, 200, { ok: true });
  };
  const sandbox = {
    window: fakeWindow, document, navigator: { userAgent: opts.ua || FB_UA, sendBeacon: (u, blob) => { beacons.push({ u, blob }); return true; } }, Blob,
    fetch: fetchStub, console, Promise, __ins: inserts, __ctl: ctl,
    setTimeout: (fn, ms) => setTimeout(fn, Math.ceil((ms || 0) / 100)), clearTimeout,
    URLSearchParams, decodeURIComponent, Intl, Date: makeFakeDate(Date.parse('2026-09-29T15:00:00Z')), Math, String, Object, Array, RegExp, JSON, Number, parseInt, isNaN, encodeURIComponent, encodeURI,
    gtag: (action, name, params) => { gtagCalls.push({ action, name, params }); },
    fbq: function () { fbqCalls.push([].slice.call(arguments)); }, clarity: fakeWindow.clarity
  };
  const ctx = vm.createContext(sandbox);
  const glue = [
    "var variant = 'f';", 'var oqInternalWalk = false;', 'var leadId = null;', 'var _oqTrackQueue = [];',
    'function trackStepComplete() {}', 'function renderStep() {}',
    'function setStoredLeadId() {}', 'function oqInternalHeader() { return {}; }',
    'function ensureSb() { return { from: function (t) { return { insert: function (p) { __ins.push({ table: t, payload: p });',
    '  var fail = __ctl.insertFailsLeft > 0; if (fail) __ctl.insertFailsLeft--;',
    '  return { setHeader: function () {}, then: function (a, b) { return Promise.resolve(fail ? { error: { message: "boom" } } : { error: null }).then(a, b); } }; } }; } }; }',
    'function appendParams(base, obj) {',
    "  var parts = Object.keys(obj || {}).filter(function (k) { return obj[k]; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]); });",
    "  if (!parts.length) return base; return base + (base.indexOf('?') === -1 ? '?' : '&') + parts.join('&'); }"
  ].join('\n');
  vm.runInContext('(function () {\n' + glue + '\n' + B.attrKeys + '\n' + B.attr + '\n' + B.track + '\n' + B.redirect + '\n' + B.insert + '\n' + B.markSaved + '\n' + B.abandon + '\n' +
    'window.__t = { trackRouter: trackRouter, redirectTo: redirectTo, markLeadSaved: markLeadSaved, appendParams: appendParams, collectAttribution: collectAttribution, insertFreshLead: insertFreshLead };\n})();',
    ctx, { filename: 'start.html (extracted blocks)' });
  const T = fakeWindow.__t;
  const bridge = {
    get sb() {
      return {
        functions: { invoke: () => { throw new Error('supabase-js invoke path must not be used when detailsUrl is set'); } },
        rpc: (name, args) => { rpcCalls.push({ name, args }); const p = Promise.resolve({ data: true, error: null }); return { then: (a, b) => p.then(a, b) }; }
      };
    },
    trackRouter: T.trackRouter, collectAttribution: T.collectAttribution, appendParams: T.appendParams, redirectTo: T.redirectTo, markLeadSaved: T.markLeadSaved,
    showError() {}, insertFreshLead: T.insertFreshLead,
    detailsUrl: 'https://proj.supabase.co/functions/v1/record-lead-details', anonKey: 'anon-key-123'
  };
  vm.runInContext(opts.moduleSrc || ROUTER, ctx, { filename: 'js/router-variant-f.js' });
  const RVF = fakeWindow.RouterVariantF;
  if (!RVF || typeof RVF.init !== 'function') throw new Error('window.RouterVariantF.init was not defined');
  RVF.init(bridge, root);
  return {
    RVF, root, gtagCalls, fbqCalls, clarityCalls, inserts, rpcCalls, detailsCalls, sentry, beacons, fakeWindow,
    firePagehide: () => (windowListeners.pagehide || []).forEach((fn) => fn()),
    ev: (name) => gtagCalls.filter((c) => c.name === name),
    leadFbq: () => fbqCalls.filter((c) => c[0] === 'track' && c[1] === 'Lead')
  };
}

// ── Drivers ─────────────────────────────────────────────────────────────────────────────────────────────────────
const P = { name: 'Zelda', phone: '(317) 255-0142', email: 'zelda@example.com', address: '742 Evergreen Terrace, Springfield, IN 46204' };
function pickFunding(s, label) { buttonByText(s.root, label).dispatchClick(); }
function fillContact(s, v) {
  byId(s.root, 'rfName').value = v.name; byId(s.root, 'rfPhone').value = v.phone; byId(s.root, 'rfEmail').value = v.email; byId(s.root, 'rfConsent').checked = !!v.consent;
}
async function toContact(s) { pickFunding(s, s.RVF.COPY.arm_f_s1_option_insurance); }
async function contactSubmit(s, consent) { fillContact(s, Object.assign({}, P, { consent: consent !== false })); buttonByText(s.root, s.RVF.COPY.arm_f_s2_button_continue).dispatchClick(); await settleN(4); }
async function addressSubmit(s) { byId(s.root, 'rfAddress').value = P.address; buttonByText(s.root, s.RVF.COPY.arm_f_s3_button_submit).dispatchClick(); await settleN(4); }

// ── The acceptance checks. chk(id, cond, label) records; a throw inside a test marks that test RED. ──────────────
async function acceptance(mod, startSrc) {
  const results = []; // { id, ok, label }
  const chk = (id, cond, label) => results.push({ id, ok: !!cond, label });
  async function T(id, fn) { try { await fn(); } catch (e) { chk(id, false, 'threw: ' + (e && e.message)); } }
  const base = { moduleSrc: mod, startSrc };

  // T1 (static half): the trust header markup, copy, asset and Arm-F scoping. The real-browser half is the Playwright file.
  await T('T1', async () => {
    const m = /<div id="oqTrustHeader">([\s\S]*?)\n  <\/div>\n  <div class="router-card">/.exec(startSrc);
    chk('T1', !!m, 'start.html has a static <div id="oqTrustHeader"> immediately above .router-card');
    const block = m ? m[1] : '';
    const idxBlock = startSrc.indexOf('<div id="oqTrustHeader">');
    chk('T1', idxBlock > startSrc.indexOf('<main>') && idxBlock < startSrc.indexOf('<div class="router-card">') && idxBlock < startSrc.indexOf('id="routerFRoot"'), 'the trust header is inside <main>, above the card and OUTSIDE #routerFRoot (the SSR-hydrate contract is untouched)');
    chk('T1', !/<a[\s>]/i.test(block) && !/<\/a>/i.test(block), 'the trust header contains NO link (the logo is not clickable: gh-2121 S07 escape-hatch rule)');
    const logo = /<img id="oqTrustLogo"([^>]*)>/.exec(block);
    chk('T1', !!logo && /src="img\/brand-assets\/otter-quotes-icon-512\.png"/.test(logo[1]) && /width="32"/.test(logo[1]) && /height="32"/.test(logo[1]) && /alt="Otter Quotes"/.test(logo[1]), 'the logo is the existing otter-quotes-icon-512.png, with explicit width/height (no layout shift) and alt "Otter Quotes"');
    chk('T1', fs.existsSync(path.join(repoRoot, 'img/brand-assets/otter-quotes-icon-512.png')), 'the logo asset exists in the repo (no new artwork)');
    const line = /<p class="oq-trust-line">([\s\S]*?)<\/p>/.exec(block);
    chk('T1', !!line && line[1].replace(/\s+/g, ' ').trim() === WHO_WE_ARE, 'the who-we-are line equals the live partner-profile.html sentence byte-for-byte: "' + WHO_WE_ARE + '"');
    chk('T1', /<span class="oq-trust-name">Otter Quotes<\/span>/.test(block), 'the wordmark text is "Otter Quotes"');
    const photo = /<img id="oqTrustPhoto"([^>]*)>/.exec(block);
    chk('T1', !!photo && /\bhidden\b/.test(photo[1]) && !/\bsrc=/.test(photo[1]) && /width="40"/.test(photo[1]) && /height="40"/.test(photo[1]), 'the photo slot ships HIDDEN with NO src (no placeholder, stock or AI image)');
    chk('T1', !fs.existsSync(path.join(repoRoot, 'img/team')), 'no img/team/ directory or photo file ships in this PR');
    chk('T1', !/(Founder|CEO|licensed|insured|A\+|rated|reviews?|vetted|\$\d)/i.test(block.replace(WHO_WE_ARE, '')), 'no caption, credential, price or review text in the header (Ben: nothing beyond logo + who-we-are + photo)');
  });

  // N1 (static half): every CSS rule this PR adds is Arm-F-scoped, and the default is display:none.
  await T('N1', async () => {
    chk('N1', /\n  #oqTrustHeader \{ display: none; \}\n/.test(startSrc), 'N1: #oqTrustHeader is display:none by default (every arm)');
    const css = startSrc.slice(startSrc.indexOf('<style'), startSrc.indexOf('</style>'));
    const rules = css.match(/^[ \t]*[^{}\n]*oqTrustHeader[^{}\n]*\{[^}\n]*\}/gm) || [];
    const bad = rules.filter((r) => !/^\s*#oqTrustHeader \{ display: none; \}$/.test(r.trim()) && !/^\s*html\[data-oq-start-arm="f"\] #oqTrustHeader/.test(r));
    chk('N1', rules.length >= 5 && bad.length === 0, 'N1: every other #oqTrustHeader rule is scoped under html[data-oq-start-arm="f"] (unscoped: ' + bad.join(' | ') + ')');
    const mainRules = css.match(/^[ \t]*[^{}\n]*\bmain\b[^{}\n]*\{[^}\n]*flex-direction[^}\n]*\}/gm) || [];
    chk('N1', mainRules.length >= 1 && mainRules.every((r) => /data-oq-start-arm="f"/.test(r)), 'N1: the column layout for <main> is Arm-F-scoped (arms D/E/A/B and a bare /start keep the row layout)');
    chk('N1', /html\[data-oq-start-arm="f"\] #site-header, html\[data-oq-start-arm="f"\] #site-footer \{ display: none; \}/.test(startSrc) && /html\[data-oq-start-arm="f"\] #step1 \{ display: none !important; \}/.test(startSrc), 'header/footer suppression on Arm F is unchanged');
  });

  // T2 order.
  await T('T2', async () => {
    const s = buildF(base);
    let contactHasAddress = null;
    await toContact(s);
    contactHasAddress = !!byId(s.root, 'rfAddress');
    chk('T2', !contactHasAddress && byId(s.root, 'rfName') && byId(s.root, 'rfPhone') && byId(s.root, 'rfEmail') && byId(s.root, 'rfConsent'), 'the contact screen has name/phone/email/consent and NO rfAddress');
    await contactSubmit(s);
    chk('T2', !!byId(s.root, 'rfAddress') && !byId(s.root, 'rfName') && !byId(s.root, 'rfPhone') && !byId(s.root, 'rfEmail') && !byId(s.root, 'rfConsent'), 'the address screen has rfAddress and none of rfName/rfPhone/rfEmail/rfConsent');
    await addressSubmit(s);
    const views = s.ev('router_step_view').map((e) => e.params.step + ':' + e.params.step_index);
    chk('T2', JSON.stringify(views) === JSON.stringify(['f-funding:1', 'f-contact:2', 'f-address:3', 'f-thanks:4']), 'router_step_view sequence is exactly f-funding:1, f-contact:2, f-address:3, f-thanks:4 (' + views.join(',') + ')');
    chk('T2', s.RVF.COPY.arm_f_s3_headline === NEW_CONTACT_HEADLINE, 'the contact headline is exactly "How should we reach you?" (the approved string minus "Almost done — ")');
    chk('T2', s.RVF.COPY.arm_f_s2_button_continue === 'Continue' && s.RVF.COPY.arm_f_s3_button_submit === 'Send My Info', 'button labels reuse the approved strings: contact "Continue", address "Send My Info"');
  });

  // T3 lead saved at contact, before any address.
  await T('T3', async () => {
    const s = buildF(base);
    await toContact(s);
    await contactSubmit(s);
    chk('T3', !!byId(s.root, 'rfAddress') && !s.detailsCalls.some((c) => c.body.property_address), 'setup: we are on the address screen and no address has been entered or sent yet');
    chk('T3', s.inserts.length === 1 && s.inserts[0].table === 'leads', 'the leads insert has happened exactly once, at the contact submit');
    const p = s.inserts[0] && s.inserts[0].payload;
    chk('T3', !!p && LEAD_RE.test(p.id) && p.name === 'Zelda' && p.email === 'zelda@example.com' && p.phone === '3172550142' && p.source === 'router' && p.variant === 'f' && p.utm_source === 'facebook' && p.utm_campaign === 'ho-1' && p.fbclid === 'T',
      'the insert carries {id, name, email, phone, source router, variant f, utm_source, utm_campaign, fbclid} from the URL');
    chk('T3', !!p && !('zip' in p), 'the insert carries NO zip (no address yet; leads.zip stays NULL for Arm F)');
    const gl = s.ev('generate_lead');
    chk('T3', gl.length === 1 && !!p && gl[0].params.event_id === p.id, 'GA4 generate_lead fired exactly once, event_id === the lead id');
    chk('T3', s.ev('router_contact_submitted').length === 1 && s.ev('router_contact_submitted')[0].params.step === 'f-contact' && s.ev('router_contact_submitted')[0].params.step_index === 2, 'router_contact_submitted fired once {f-contact, 2}');
    chk('T3', s.leadFbq().length === 1 && !!p && s.leadFbq()[0][3].eventID === p.id, 'Meta Lead fired exactly once with the same event_id');
    const roles = s.rpcCalls.filter((c) => c.name === 'set_lead_role');
    chk('T3', roles.length === 1 && roles[0].args.p_role === 'homeowner' && !!p && roles[0].args.p_lead_id === p.id, 'set_lead_role called once with homeowner (this trips the #1932 new-lead alert)');
    chk('T3', s.detailsCalls.length === 1 && s.detailsCalls[0].body.property_address === null && s.detailsCalls[0].body.consent && s.detailsCalls[0].body.consent.key === 'arm_f_s3_consent_checkbox' && s.detailsCalls[0].body.lead_id === (p && p.id),
      'record-lead-details called once, with the consent object and property_address null');
  });

  // T4 address is an update.
  await T('T4', async () => {
    const s = buildF(base);
    await toContact(s); await contactSubmit(s);
    const first = s.detailsCalls[0] && s.detailsCalls[0].body;
    await addressSubmit(s);
    chk('T4', s.inserts.length === 1, 'the address submit makes NO second leads insert');
    const second = s.detailsCalls[1] && s.detailsCalls[1].body;
    chk('T4', s.detailsCalls.length === 2 && !!second && !!first && second.lead_id === first.lead_id && second.property_address === P.address, 'record-lead-details called a second time, same lead_id, property_address set');
    chk('T4', !!second && !!first && JSON.stringify(second.consent) === JSON.stringify(first.consent), 'the consent object is deep-equal to the first (same key / given / text)');
    chk('T4', s.ev('generate_lead').length === 1 && s.leadFbq().length === 1 && s.rpcCalls.filter((c) => c.name === 'set_lead_role').length === 1, 'the address step does not re-fire the conversion, Meta Lead or set_lead_role (each exactly once per lead)');
  });

  // T5 attribution lands on the lead row; lead_id on every later event.
  await T('T5', async () => {
    const url = 'https://otterquote.com/start?utm_source=facebook&utm_medium=paid&utm_campaign=ho-1&utm_content=c1&fbclid=REALISH&v=f';
    const s = buildF(Object.assign({}, base, { url }));
    await toContact(s); await contactSubmit(s); await addressSubmit(s);
    const p = s.inserts[0] && s.inserts[0].payload;
    chk('T5', !!p && p.utm_source === 'facebook' && p.utm_medium === 'paid' && p.utm_campaign === 'ho-1' && p.utm_content === 'c1' && p.fbclid === 'REALISH' && p.variant === 'f', 'the insert payload has utm_source/medium/campaign/content and fbclid equal to the URL values, and variant f');
    const ev = s.gtagCalls.filter((c) => c.action === 'event');
    const iSub = ev.findIndex((c) => c.name === 'router_contact_submitted');
    const after = ev.slice(iSub);
    chk('T5', iSub > -1 && after.length >= 4 && after.every((c) => !!p && c.params.lead_id === p.id && c.params.variant === 'f' && typeof c.params.step === 'string' && typeof c.params.step_index === 'number' && c.params.ua_context === 'fb_iab'),
      'every router event from the insert onward carries lead_id, variant, step, step_index, ua_context (' + after.map((c) => c.name).join(',') + ')');
    const c = buildF(Object.assign({}, base, { url: 'https://otterquote.com/start?v=f&utm_source=facebook', cookie: '_fbc=fb.1.1700000000.cookieFbc; _fbp=fb.1.1700000000.cookieFbp' }));
    await toContact(c); await contactSubmit(c);
    chk('T5', c.detailsCalls.length === 1 && c.detailsCalls[0].body.fbc === 'fb.1.1700000000.cookieFbc', 'with only the _fbc cookie (no fbclid in the URL), the details body fbc equals the cookie');
  });

  // T6 PII discipline.
  await T('T6', async () => {
    const s = buildF(base);
    await toContact(s); await contactSubmit(s, true); await addressSubmit(s);
    const everything = JSON.stringify([s.gtagCalls, s.fbqCalls, s.clarityCalls]);
    const banned = ['Evergreen', '46204', 'Springfield', 'Zelda', 'zelda@example.com', '2550142', '255-0142', 'insurance', 'autodialer', 'call or text', 'IwAR'];
    const leaked = banned.filter((t) => everything.indexOf(t) !== -1);
    chk('T6', leaked.length === 0, 'no address, phone, email, name, funding value or consent text in any GA4 / Meta / Clarity payload (leaked: ' + leaked.join(',') + ')');
    const keys = new Set(); s.gtagCalls.forEach((c) => Object.keys(c.params || {}).forEach((k) => keys.add(k)));
    chk('T6', [...keys].every((k) => ['step', 'step_index', 'variant', 'ua_context', 'lead_id', 'event_id'].indexOf(k) !== -1), 'every GA4 parameter key is one of step / step_index / variant / ua_context / lead_id / event_id');
  });

  // T7 consent byte identity.
  await T('T7', async () => {
    const s = buildF(base);
    await toContact(s);
    const label = flatten(s.root).find((c) => c.tagName === 'LABEL' && c.getAttribute('for') === 'rfConsent');
    chk('T7', !!label && md5(label.textContent) === APPROVED_CONSENT_MD5, 'the rendered consent label md5 is ' + APPROVED_CONSENT_MD5);
    chk('T7', md5(s.RVF.COPY.arm_f_s3_consent_checkbox) === APPROVED_CONSENT_MD5, 'COPY.arm_f_s3_consent_checkbox md5 is ' + APPROVED_CONSENT_MD5);
    const priv = byId(s.root, 'rfPrivacy');
    const links = priv ? flatten(priv).filter((c) => c.tagName === 'A') : [];
    chk('T7', !!priv && priv.textContent === APPROVED_PRIVACY && links.length === 2 && links[0].getAttribute('href') === 'privacy.html' && links[1].getAttribute('href') === 'terms.html', 'the privacy line is exactly "' + APPROVED_PRIVACY + '" with anchors privacy.html and terms.html');
    chk('T7', byId(s.root, 'rfConsent').checked === false, 'the consent checkbox is UNCHECKED by default');
    const kids = byId(s.root, 'rfConsent').parentNode.parentNode.children; // the "number above" adjacency: phone field precedes the consent row
    chk('T7', kids.indexOf(byId(s.root, 'rfPhone').parentNode) < kids.indexOf(byId(s.root, 'rfConsent').parentNode), 'the phone field stays ABOVE the consent text (the text says "the number above")');
    await contactSubmit(s, true);
    chk('T7', s.detailsCalls.length === 1 && md5(s.detailsCalls[0].body.consent.text) === APPROVED_CONSENT_MD5 && s.detailsCalls[0].body.consent.given === true, 'the consent object sent to the server carries the exact text (md5) and the given value the visitor chose');
  });

  // T8 abandon.
  await T('T8', async () => {
    const s = buildF(base);
    await toContact(s); await contactSubmit(s);
    s.firePagehide();
    const ab = s.ev('router_step_abandoned');
    chk('T8', ab.length === 1 && ab[0].params.step === 'f-address' && ab[0].params.step_index === 3 && ab[0].params.variant === 'f', 'a pagehide on f-address after the lead is saved fires exactly one router_step_abandoned {f-address, 3, variant f}');
    const t = buildF(base);
    await toContact(t); await contactSubmit(t); await addressSubmit(t);
    t.firePagehide();
    chk('T8', t.ev('router_step_abandoned').length === 0, 'a pagehide on f-thanks fires none');
  });

  // T9 failures.
  await T('T9', async () => {
    const f = buildF(Object.assign({}, base, { insertFails: 1 }));
    await toContact(f); await contactSubmit(f);
    chk('T9', f.ev('generate_lead').length === 0 && f.leadFbq().length === 0 && f.ev('router_contact_submitted').length === 0, 'a failed insert fires no conversion event (no generate_lead, no Meta Lead, no router_contact_submitted)');
    chk('T9', !byId(f.root, 'rfAddress') && !!byId(f.root, 'rfName'), 'a failed insert does not advance to the address screen');
    const btn = buttonByText(f.root, f.RVF.COPY.arm_f_s2_button_continue);
    chk('T9', !!btn && !btn.disabled, 'a failed insert re-enables the form');
    chk('T9', flatten(f.root).some((c) => c.textContent === f.RVF.COPY.arm_f_error_generic), 'a failed insert shows the generic error');
    chk('T9', f.detailsCalls.length === 0 && f.rpcCalls.length === 0, 'a failed insert makes no details call and no set_lead_role');
    const s = buildF(Object.assign({}, base, { detailsMode: 'fail-address' }));
    await toContact(s); await contactSubmit(s);
    byId(s.root, 'rfAddress').value = P.address;
    buttonByText(s.root, s.RVF.COPY.arm_f_s3_button_submit).dispatchClick();
    await settleN(4); await sleep(150);
    chk('T9', s.detailsCalls.filter((c) => c.body.property_address).length === 2, 'the address details call fails twice (one retry, then stops)');
    chk('T9', s.sentry.length === 1 && /record-lead-details failed after 2 attempt/.test(s.sentry[0].msg) && s.sentry[0].ctx.extra.lead_id === (s.inserts[0] && s.inserts[0].payload.id), 'a Sentry report is filed with the lead id');
    const rep = JSON.stringify(s.sentry);
    chk('T9', ['Evergreen', '46204', 'Zelda', 'zelda@example.com', '255', 'insurance', 'autodialer'].every((t) => rep.indexOf(t) === -1), 'the Sentry report carries no PII (no address, name, contact, funding, consent text)');
    chk('T9', s.ev('router_step_view').some((e) => e.params.step === 'f-thanks'), 'the thank-you screen is still reached after the address call fails');
  });

  return results;
}

function summarize(results) {
  const byTest = {};
  results.forEach((r) => { (byTest[r.id] = byTest[r.id] || []).push(r); });
  return byTest;
}
function redIds(results) { return Object.keys(summarize(results)).filter((id) => summarize(results)[id].some((r) => !r.ok)).sort(); }

// ── Mutations for the negative controls ─────────────────────────────────────────────────────────────────────────
function mutateOnce(src, from, to, label) {
  const parts = src.split(from);
  if (parts.length < 2) throw new Error('mutation anchor not found: ' + label);
  return parts.join(to);
}
// N2: put the address BEFORE contact (funding -> address -> contact -> thanks) using only the current source.
function mutateReorder(src) {
  let m = mutateOnce(src, "go('f-contact');\n      });\n      wrap.appendChild(btn);", "go('f-address');\n      });\n      wrap.appendChild(btn);", 'N2 funding rebuild');
  m = mutateOnce(m, "        go('f-contact');\n      });\n    });\n    // gh-2121 round 3", "        go('f-address');\n      });\n    });\n    // gh-2121 round 3", 'N2 funding hydrate');
  m = mutateOnce(m, "      saveAddress();\n", "      go('f-contact');\n", 'N2 address handler');
  m = mutateOnce(m, "      go('f-address');\n    }, saveFailed);", "      go('f-thanks');\n    }, saveFailed);", 'N2 contact resolution');
  return m;
}

async function main() {
  console.log('=== gh-2362 acceptance: T1 (static) and T2-T9 against the real sources ===');
  const real = await acceptance(ROUTER, START);
  real.forEach((r) => ok(r.ok, r.id + ': ' + r.label));
  const ids = Object.keys(summarize(real)).sort();
  ok(['N1', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'].every((i) => ids.indexOf(i) !== -1), 'every one of T1 (static), T2-T9 ran at least one check (' + ids.join(',') + ')');
  ok(redIds(real).length === 0, 'the unmutated sources are fully green (red: ' + redIds(real).join(',') + ')');

  // The must-not-change list, statically.
  console.log('\n=== Must-NOT-change list (spec 2.6) ===');
  ok(/STEP_INDEX = \{ 'f-funding': 1, 'f-contact': 2, 'f-address': 3, 'f-thanks': 4 \}/.test(ROUTER), 'STEP_INDEX is positional: f-funding 1, f-contact 2, f-address 3, f-thanks 4 (tokens unchanged)');
  ok(/var CONSENT_KEY = 'arm_f_s3_consent_checkbox';/.test(ROUTER), "consent.key stays 'arm_f_s3_consent_checkbox'");
  ok(/fbq\('track', 'Lead', \{\}, \{ eventID: eventId \}\)/.test(ROUTER) && /'router_contact_submitted'/.test(ROUTER) && /'generate_lead'/.test(ROUTER), 'the conversion events keep their names and the Meta Lead call shape');
  ok(/var KNOWN_ARMS = \['a', 'b', 'c', 'd', 'e', 'f'\];/.test(START) && /var DIRECT_ONLY_ARMS = \['f'\]/.test(START) && /var LIVE_VARIANTS = \['d',\s*'e'\]/.test(START), 'KNOWN_ARMS / DIRECT_ONLY_ARMS / LIVE_VARIANTS are unchanged');
  ok(/var INSERT_EXTRA_COLUMNS = \['zip'\];/.test(START) && /var ATTR_KEYS = \['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'v'\];/.test(START), 'INSERT_EXTRA_COLUMNS and ATTR_KEYS are unchanged in start.html');
  ok(/id="routerFRoot"[^>]*data-ssr-step="f-funding"/.test(START), 'the SSR-hydrate markup contract on #routerFRoot is unchanged');
  ok(!fs.existsSync(path.join(repoRoot, 'supabase/migrations')) || !/gh2362|2362/.test(fs.readdirSync(path.join(repoRoot, 'supabase/migrations')).join('\n')), 'no migration for this issue (Q3: no migration in this PR)');

  // Negative controls.
  console.log('\n=== Negative controls (each mutation must turn the named test RED) ===');
  {
    const unscoped = mutateOnce(START, 'html[data-oq-start-arm="f"] #oqTrustHeader { display: block;', '#oqTrustHeader { display: block;', 'N1');
    const r = redIds(await acceptance(ROUTER, unscoped));
    ok(r.indexOf('N1') !== -1, 'N1: un-scoping the trust header (visible on every arm) turns N1 RED (red: ' + r.join(',') + ')');
  }
  {
    const r = redIds(await acceptance(mutateReorder(ROUTER), START));
    ok(r.indexOf('T2') !== -1 && r.indexOf('T3') !== -1, 'N2: re-ordering back to address-before-contact turns T2 AND T3 RED (red: ' + r.join(',') + ')');
  }
  {
    const m = mutateOnce(ROUTER, '      fireConversion();\n      // NOT bridge.markLeadSaved() here', '      fireConversion();\n      bridge.markLeadSaved();\n      // NOT bridge.markLeadSaved() here', 'N3');
    const r = redIds(await acceptance(m, START));
    ok(r.indexOf('T8') !== -1, 'N3: calling markLeadSaved() at the contact save turns T8 RED (red: ' + r.join(',') + ')');
  }
  {
    const m = mutateOnce(ROUTER, 'may call or text me at the number above', 'may call or texts me at the number above', 'N4');
    const r = redIds(await acceptance(m, START));
    ok(r.indexOf('T7') !== -1, 'N4: changing one character of the consent text turns T7 RED (red: ' + r.join(',') + ')');
  }
  {
    const m = mutateOnce(START, '<img id="oqTrustLogo"', '<a href="/"><img id="oqTrustLogo"', 'N5 open');
    const m2 = mutateOnce(m, 'alt="Otter Quotes" decoding="async">', 'alt="Otter Quotes" decoding="async"></a>', 'N5 close');
    const r = redIds(await acceptance(ROUTER, m2));
    ok(r.indexOf('T1') !== -1, 'N5: wrapping the logo in an <a> turns T1 RED (red: ' + r.join(',') + ')');
  }

  console.log('\n=== Summary ===\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('UNCAUGHT:', e); process.exit(1); });
