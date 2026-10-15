/**
 * gh-2598 slice 6 -- /start reads the ZIP the new homepage left in sessionStorage['oq_home_zip'].
 *
 * Spec (issue #2598, comment 6067600190, correction 1): the ZIP is handed over in the visitor's own tab, never in a URL (/start loads the
 * Meta pixel, GA4 and Clarity, which record page URLs). /start reads and clears the key, tests the stale-state case, and the entry in
 * tests/fixtures/gh2060-storage-surface-ledger.json moves from write-only to tested. Decomposition row 6 (comment 6051878928): skip the
 * "I am a..." role screen when entry=home; direct arrival still shows it.
 *
 * Narrowest reading, stated: no live arm (D, E) has a ZIP field, so "prefill / use" means the ZIP rides on the homeowner's `leads` insert in the
 * existing allow-listed `zip` column (insertFreshLead's extraColumns), and the role screen is skipped on D and E.
 *
 * Everything here EXECUTES the shipped code: readHomeHandoff() is extracted verbatim out of start.html and run in a vm; js/router-variant-d.js and
 * js/router-variant-e.js (and js/router-discovery.js) are run in vm contexts behind the DOM shim copied from tests/gh2076-variant-e.mjs. The bridge
 * is a stub that records the arguments the modules pass to insertFreshLead; no Supabase, no network.
 *
 * Negative control: HOME_ZIP_ROOT=<dir holding another checkout> runs the same checks against that tree (CI-less proof against main).
 *
 * Run: node tests/gh2598-start-home-zip.mjs
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.HOME_ZIP_ROOT || path.join(__dirname, '..');
const rd = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const startHtmlSrc = rd('start.html');
const variantDSrc = rd('js/router-variant-d.js');
const variantESrc = rd('js/router-variant-e.js');
const discoverySrc = rd('js/router-discovery.js');
const ZIP = '46077';

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

// ── Minimal DOM shim, copied verbatim from tests/gh2076-variant-e.mjs (the same files touch the same DOM surface). ──
function makeDom(ctxCell) {
  const registry = {};
  // #2088 round 2, item 10: a controllable fake clock, per scenario (each
  // buildScenario() call gets its own makeDom(), hence its own
  // clockState) -- wired to this context's own `Date.now` by buildScenario
  // below. Every ordinary dispatchClick()/dispatchEvent() call advances it
  // by a full second BEFORE firing, so two SEPARATE test actions (a
  // legitimate first tap on a freshly-rendered screen, then a later,
  // deliberate second action) always look >350ms apart to init()'s own
  // root click-guard -- exactly like a real visitor, who needs at least
  // that long to see the new screen and react, never mind two of THIS
  // suite's chained .then()/settle() steps in between. The *Instant
  // variants below skip that advance, for the one thing this fake clock
  // exists to let a test actually simulate: two taps landing in the SAME
  // instant.
  const clockState = { now: 1000000 };
  function syncClassName(el) { el.className = el._classes.join(' '); }

  // #2088 round 2, item 10: real DOM-style event propagation -- capturing
  // phase (outermost ancestor to target's immediate parent, capture:true
  // listeners only) runs FIRST; if any capturing listener calls
  // event.stopPropagation(), dispatch stops there and the target's own
  // listeners never run (this is what init()'s 350ms click guard, attached
  // to routerERoot with capture:true, depends on). Otherwise the target's
  // own bubble-registered (capture:false) listeners run. Bubbling past the
  // target is not implemented -- nothing in these two files listens above
  // the target except routerERoot's own capturing guard, which is already
  // covered by the capturing phase above.
  function dispatchDomEvent(target, type, opts) {
    if (!opts || opts.advanceClock !== false) { clockState.now += 1000; }
    const chain = [];
    let cur = target;
    while (cur) { chain.push(cur); cur = cur.parentNode; }
    const event = { type: type, preventDefault() {}, stopPropagation() { event._stopped = true; } };
    const capturePath = chain.slice(1).reverse(); // ancestors only, outermost first
    for (const node of capturePath) {
      const entries = (node._listeners[type] || []).filter((e) => e.capture);
      for (const entry of entries) {
        entry.fn(event);
        if (event._stopped) return;
      }
    }
    const targetEntries = (target._listeners[type] || []).filter((e) => !e.capture);
    for (const entry of targetEntries) { entry.fn(event); }
  }

  function createElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      _classes: [],
      children: [],
      attributes: {},
      style: {},
      _listeners: {},
      _text: '',
      _html: '',
      parentNode: null,
      get className() { return this._classes.join(' '); },
      set className(v) { this._classes = v ? String(v).split(/\s+/).filter(Boolean) : []; },
      get textContent() {
        if (this.children.length) {
          return this.children.map((c) => (c.textContent != null ? c.textContent : '')).join('');
        }
        return this._text;
      },
      set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = v; },
      get firstChild() { return this.children.length ? this.children[0] : null; },
      appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
      removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
      setAttribute(k, v) {
        this.attributes[k] = v;
        if (k === 'id') { this.id = v; registry[v] = this; }
      },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
      querySelector(sel) {
        const attrM = /^\[([a-zA-Z0-9_-]+)\]$/.exec(sel);
        const classM = /^\.([a-zA-Z0-9_-]+)$/.exec(sel);
        if (!attrM && !classM) return null;
        const stack = this.children.slice();
        while (stack.length) {
          const node = stack.shift();
          if (attrM && node.attributes && Object.prototype.hasOwnProperty.call(node.attributes, attrM[1])) return node;
          if (classM && node._classes && node._classes.includes(classM[1])) return node;
          if (node.children && node.children.length) stack.push(...node.children);
        }
        return null;
      },
      addEventListener(evt, fn, capture) { (this._listeners[evt] = this._listeners[evt] || []).push({ fn: fn, capture: !!capture }); },
      removeEventListener(evt, fn) {
        if (!this._listeners[evt]) return;
        this._listeners[evt] = this._listeners[evt].filter((entry) => entry.fn !== fn);
      },
      // A disabled button fires no click listeners in a real browser --
      // matched here so a synchronous double-dispatchClick() on a button a
      // handler just disabled (e.g. RD.renderPartnerContact's own
      // submitBtn.disabled=true, or e-p7-5's onSubmit) exercises the SAME
      // guard a real double-tap would hit, instead of re-entering a
      // handler no production browser would ever re-enter. Routed through
      // dispatchDomEvent (see below) for real capture-phase propagation.
      dispatchClick() { if (this.disabled) return; dispatchDomEvent(this, 'click'); },
      // #2088 round 2, item 10: fires a non-click DOM event (used for
      // e-p7-5/e-p13's own <form> 'submit' listener) through the SAME
      // capture/bubble propagation as dispatchClick, minus the `disabled`
      // check (forms have no such concept).
      dispatchEvent(type) { dispatchDomEvent(this, type); },
      // #2088 round 2, item 10: the ONLY way this suite simulates two taps
      // landing in the SAME instant -- skips the fake clock's usual
      // per-dispatch advance, so init()'s own 350ms root click-guard sees
      // (correctly) zero elapsed time since the target screen was shown
      // and swallows this click before it reaches the target's own
      // listener.
      dispatchClickSameInstant() { if (this.disabled) return; dispatchDomEvent(this, 'click', { advanceClock: false }); },
      dispatchEventSameInstant(type) { dispatchDomEvent(this, type, { advanceClock: false }); },
      classList: {
        add: function (c) {},
        remove: function (c) {},
        toggle: function (c, force) {}
      }
    };
    if (tag === 'input') el.value = '';
    el.classList.add = (c) => { if (!el._classes.includes(c)) { el._classes.push(c); syncClassName(el); } };
    el.classList.remove = (c) => { el._classes = el._classes.filter((x) => x !== c); syncClassName(el); };
    if (tag === 'script') {
      let _src = null;
      Object.defineProperty(el, 'src', {
        get() { return _src; },
        set(v) {
          _src = v;
          // Deferred to a microtask -- same reason tests/gh2075-variant-d.mjs's
          // own shim defers it: .onload/.onerror are attached AFTER .src
          // in real code (router-variant-e.js's own loadDiscoveryModule()),
          // and running the "fetch" synchronously would fire load before
          // .onload is assigned.
          const ctxAtSet = ctxCell.ctx;
          Promise.resolve().then(() => {
            try {
              let code = null;
              if (String(v).indexOf('router-discovery.js') !== -1) code = discoverySrc;
              if (code == null) throw new Error('unstubbed script src in test: ' + v);
              vm.runInContext(code, ctxAtSet, { filename: v });
              if (el._listeners.load) el._listeners.load.forEach((entry) => entry.fn());
            } catch (e) {
              if (el._listeners.error) el._listeners.error.forEach((entry) => entry.fn(e));
              else throw e;
            }
          });
        }
      });
      Object.defineProperty(el, 'onload', {
        set(fn) { el.addEventListener('load', fn); },
        get() { return undefined; }
      });
      Object.defineProperty(el, 'onerror', {
        set(fn) { el.addEventListener('error', fn); },
        get() { return undefined; }
      });
    }
    return el;
  }

  const body = { appendChild: (el) => el };
  const document = {
    createElement,
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    getElementById: (id) => registry[id] || null,
    body
  };
  return { document, registry, clockState };
}

function extractFunction(src, name) {
  const anchor = `function ${name}(`;
  const start = src.indexOf(anchor);
  if (start === -1) return null;
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function flatten(el) { const out = [el]; (el.children || []).forEach((c) => { out.push(...flatten(c)); }); return out; }
function findOptionButtons(root) { return flatten(root).filter((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('role-option')); }
function findButton(root, text) { return flatten(root).find((c) => c.tagName === 'BUTTON' && c.textContent === text); }
function findBack(root) { return flatten(root).find((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('router-back')); }
function h1(root) { const h = flatten(root).find((c) => c.tagName === 'H1'); return h ? h.textContent : null; }
function settle() { return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => Promise.resolve()); }

// ---- S1: readHomeHandoff(), extracted from start.html and run -------------------------------------------------------------------
const readSrc = extractFunction(startHtmlSrc, 'readHomeHandoff');
function runHandoff(search, store, opts = {}) {
  const log = { removed: 0 };
  const storage = {
    getItem: (k) => { if (opts.getThrows) throw new Error('blocked'); return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    removeItem: (k) => { log.removed++; if (opts.removeThrows) throw new Error('blocked'); delete store[k]; }
  };
  const ctx = vm.createContext({ window: { location: { search }, sessionStorage: storage }, URLSearchParams });
  vm.runInContext(readSrc + '\nglobalThis.__r = readHomeHandoff();', ctx);
  return { result: ctx.__r, store, log };
}
ok(!!readSrc, 'S1 start.html defines readHomeHandoff()');
if (readSrc) {
  let r = runHandoff('?entry=home&utm_source=x', { oq_home_zip: ZIP });
  ok(r.result.zip === ZIP && r.result.skipRole === true, 'S1 entry=home with a stored 5-digit ZIP: returns the ZIP and skipRole');
  ok(!('oq_home_zip' in r.store), 'S1 the key is removed after the read (read-and-clear)');

  r = runHandoff('?entry=home', {});
  ok(r.result.zip === null && r.result.skipRole === true, 'S1 entry=home with no key: no ZIP, role screen still skipped');

  r = runHandoff('', { oq_home_zip: ZIP });
  ok(r.result.zip === null && r.result.skipRole === false, 'S1 STALE STATE: a leftover key on a direct visit (no entry=home) is ignored, role screen kept');
  ok(!('oq_home_zip' in r.store), 'S1 STALE STATE: ...and the leftover key is still cleared, so it cannot resurface later');

  r = runHandoff('?entry=other', { oq_home_zip: ZIP });
  ok(r.result.zip === null && r.result.skipRole === false && !('oq_home_zip' in r.store), 'S1 any entry value other than "home" behaves like a direct visit and clears the key');

  for (const bad of ['4607', '460777', '46077x', 'abcde', ' 46077', '46077\n<script>', '']) {
    r = runHandoff('?entry=home', { oq_home_zip: bad });
    ok(r.result.zip === null && !('oq_home_zip' in r.store), 'S1 malformed stored value ' + JSON.stringify(bad) + ' is rejected and cleared');
  }

  r = runHandoff('?zip=46077&entry=home', {});
  ok(r.result.zip === null, 'S1 a ?zip= URL parameter is never read (the ZIP never travels in a URL)');

  r = runHandoff('?entry=home', { oq_home_zip: ZIP }, { getThrows: true });
  ok(r.result.zip === null && r.result.skipRole === true, 'S1 storage that throws on read does not break the page: no ZIP, role screen skipped');
  r = runHandoff('?entry=home', { oq_home_zip: ZIP }, { removeThrows: true });
  ok(r.result.zip === ZIP && r.log.removed === 1, 'S1 storage that throws on remove does not break the page, and the remove was still attempted');

  const bridgeRefs = (startHtmlSrc.match(/homeEntry: homeEntry/g) || []).length;
  ok(bridgeRefs === 2, 'S1 start.html hands homeEntry to exactly the two live arms\' bridges (D and E); found ' + bridgeRefs);
  ok(/var homeEntry = readHomeHandoff\(\);/.test(startHtmlSrc), 'S1 start.html calls readHomeHandoff() once, at load');
}

// ---- scenario builder (D or E module in a vm, stub bridge) ------------------------------------------------------------------------
function buildScenario(arm, homeEntry) {
  const ctxCell = {};
  const { document, clockState } = makeDom(ctxCell);
  const root = document.createElement('div');
  const tracked = [];
  const insertCalls = [];
  const rpcCalls = [];
  const bridge = {
    get sb() { return { rpc: (name, args) => { rpcCalls.push({ name, args }); const p = Promise.resolve({ data: true, error: null }); return { then: (a, b) => p.then(a, b) }; } }; },
    trackRouter: (name, extra) => { tracked.push({ name, extra: Object.assign({}, extra) }); },
    collectAttribution: () => ({}),
    insertFreshLead: (name, email, phone, isSynthetic, variantOverride, extraColumns) => {
      insertCalls.push({ name, email, phone, variantOverride, extraColumns });
      return Promise.resolve('lead-' + insertCalls.length);
    },
    appendParams: (b) => b,
    redirectTo: () => {},
    showError: (msg) => { throw new Error('bridge.showError: ' + msg); },
    ROLE_DESTINATIONS: { homeowner: 'https://app.otterquote.com/get-started', contractor: 'contractor-join.html' },
    PARTNER_INDUSTRY_DESTINATIONS: {}, NO_LEAD_ID_DESTINATIONS: {},
    oqInternalOverride: false
  };
  if (homeEntry !== undefined) bridge.homeEntry = homeEntry;
  const sandbox = {
    document,
    window: { addEventListener() {}, removeEventListener() {}, document, AgentTypes: { CHOOSER_LABELS: { re_agent: 'Real Estate Agent', insurance_agent: 'Insurance Agent', home_inspector: 'Home Inspector', adjuster: 'Adjuster', other: 'Other' } } },
    console, Promise, setTimeout, encodeURIComponent, Object, Array, String, URLSearchParams, RegExp,
    Date: { now: () => clockState.now }
  };
  const ctx = vm.createContext(sandbox);
  ctxCell.ctx = ctx;
  vm.runInContext(arm === 'd' ? variantDSrc : variantESrc, ctx, { filename: arm === 'd' ? 'js/router-variant-d.js' : 'js/router-variant-e.js' });
  const mod = arm === 'd' ? ctx.window.RouterVariantD : ctx.window.RouterVariantE;
  return { root, bridge, mod, tracked, insertCalls, rpcCalls };
}
const views = (tracked) => tracked.filter((e) => e.name === 'router_step_view').map((e) => e.extra.step);
const types = (root) => flatten(root).filter((c) => c.tagName === 'INPUT');
function typeAndSubmit(root, id, value) {
  const input = flatten(root).find((c) => c.id === id);
  input.value = value;
  findButton(root, 'Continue').dispatchClick();
}

// ---- D ---------------------------------------------------------------------------------------------------------------------
async function dScenarios() {
  let s = buildScenario('d', { skipRole: true, zip: ZIP });
  s.mod.init(s.bridge, s.root);
  await settle();
  ok(h1(s.root) === 'What is your email?', 'D entry=home: the first screen is the email screen, not "I am a..."');
  ok(views(s.tracked).join(',') === 'd-email' && !s.tracked.some((e) => e.name === 'router_role_selected'), 'D entry=home: only d-email is viewed, and no role-selected event is faked');
  typeAndSubmit(s.root, 'dEmail', 'jane@example.com');
  await settle();
  ok(s.insertCalls.length === 1 && s.insertCalls[0].email === 'jane@example.com', 'D entry=home: exactly one leads insert at the email screen');
  ok(s.insertCalls[0].extraColumns && s.insertCalls[0].extraColumns.zip === ZIP && Object.keys(s.insertCalls[0].extraColumns).join() === 'zip', 'D entry=home: the insert carries the ZIP, and only as the allow-listed `zip` column');
  const roleRpc = s.rpcCalls.find((c) => c.name === 'set_lead_role');
  ok(roleRpc && roleRpc.args.p_role === 'homeowner', 'D entry=home: the lead row gets role=homeowner');

  s = buildScenario('d', { skipRole: true, zip: ZIP });
  s.mod.init(s.bridge, s.root);
  await settle();
  findBack(s.root).dispatchClick();
  await settle();
  ok(h1(s.root) === 'I am a…', 'D entry=home: Back from the email screen still reaches the role screen');
  findOptionButtons(s.root).find((b) => /^Contractor/.test(b.textContent)).dispatchClick();
  await settle();
  typeAndSubmit(s.root, 'dEmail', 'pro@example.com');
  await settle();
  ok(s.insertCalls.length === 1 && s.insertCalls[0].extraColumns === undefined, 'D entry=home then role changed to contractor: the ZIP is NOT written to that row');

  s = buildScenario('d', { skipRole: true, zip: null });
  s.mod.init(s.bridge, s.root);
  await settle();
  ok(h1(s.root) === 'What is your email?', 'D entry=home with no ZIP: role screen still skipped');
  typeAndSubmit(s.root, 'dEmail', 'jane@example.com');
  await settle();
  ok(s.insertCalls.length === 1 && s.insertCalls[0].extraColumns === undefined, 'D entry=home with no ZIP: the insert carries no extra columns');

  for (const he of [undefined, { skipRole: false, zip: null }]) {
    s = buildScenario('d', he);
    s.mod.init(s.bridge, s.root);
    await settle();
    ok(h1(s.root) === 'I am a…' && views(s.tracked).join(',') === 'd-role', 'D direct arrival (' + (he ? 'skipRole false' : 'no homeEntry on the bridge') + '): the role screen is shown first');
    findOptionButtons(s.root)[0].dispatchClick();
    await settle();
    typeAndSubmit(s.root, 'dEmail', 'jane@example.com');
    await settle();
    ok(s.insertCalls.length === 1 && s.insertCalls[0].extraColumns === undefined, 'D direct arrival: the homeowner insert carries no extra columns');
  }
}

// ---- E ---------------------------------------------------------------------------------------------------------------------
async function driveEToEmail(s) {
  // from e-p2: Continue -> e-p3 (Me) -> e-p4a Continue -> e-p5 (first trade) Continue -> e-p5-5 name -> e-p6 (None of the above) Continue -> e-p7 Continue -> e-p7-5
  findButton(s.root, 'Continue').dispatchClick(); await settle();
  findOptionButtons(s.root)[0].dispatchClick(); await settle();
  findButton(s.root, 'Continue').dispatchClick(); await settle();
  findOptionButtons(s.root)[0].dispatchClick();
  findButton(s.root, 'Continue').dispatchClick(); await settle();
  typeAndSubmit(s.root, 'eName', 'Jane Smith'); await settle();
  findOptionButtons(s.root)[4].dispatchClick();
  findButton(s.root, 'Continue').dispatchClick(); await settle();
  findButton(s.root, 'Continue').dispatchClick(); await settle();
  typeAndSubmit(s.root, 'eEmail', 'jane@example.com'); await settle();
}
async function eScenarios() {
  let s = buildScenario('e', { skipRole: true, zip: ZIP });
  s.mod.init(s.bridge, s.root);
  await settle();
  ok(findOptionButtons(s.root).length === 0 && /Otter Quotes helps homeowners/.test(flatten(s.root).map((c) => c._text || '').join(' ')), 'E entry=home: the first screen is the homeowner exposition (e-p2), not the role screen');
  ok(views(s.tracked).join(',') === 'e-p2' && !s.tracked.some((e) => e.name === 'router_role_selected'), 'E entry=home: only e-p2 is viewed, no e-p1 view and no faked role event');
  await driveEToEmail(s);
  ok(s.insertCalls.length === 1 && s.insertCalls[0].email === 'jane@example.com' && s.insertCalls[0].name === 'Jane Smith', 'E entry=home: one leads insert, at the email screen, with the name and email');
  ok(s.insertCalls[0].extraColumns && s.insertCalls[0].extraColumns.zip === ZIP && Object.keys(s.insertCalls[0].extraColumns).join() === 'zip', 'E entry=home: the insert carries the ZIP, only as the allow-listed `zip` column');
  const roleRpc = s.rpcCalls.find((c) => c.name === 'set_lead_role');
  ok(roleRpc && roleRpc.args.p_role === 'homeowner', 'E entry=home: the lead row gets role=homeowner');

  s = buildScenario('e', { skipRole: true, zip: ZIP });
  s.mod.init(s.bridge, s.root);
  await settle();
  findButton(s.root, 'Continue').dispatchClick();
  await settle();
  findBack(s.root).dispatchClick();
  await settle();
  ok(/Otter Quotes helps homeowners/.test(flatten(s.root).map((c) => c._text || '').join(' ')), 'E entry=home: Back from e-p3 returns to e-p2 (the module stack works from the skipped start)');

  s = buildScenario('e', { skipRole: true, zip: null });
  s.mod.init(s.bridge, s.root);
  await settle();
  await driveEToEmail(s);
  ok(s.insertCalls.length === 1 && s.insertCalls[0].extraColumns === undefined, 'E entry=home with no ZIP: role screen skipped, insert carries no extra columns');

  for (const he of [undefined, { skipRole: false, zip: null }]) {
    s = buildScenario('e', he);
    s.mod.init(s.bridge, s.root);
    await settle();
    ok(findOptionButtons(s.root).length === 3 && views(s.tracked).join(',') === 'e-p1', 'E direct arrival (' + (he ? 'skipRole false' : 'no homeEntry on the bridge') + '): the role screen is shown first');
    findOptionButtons(s.root)[0].dispatchClick();
    await settle();
    await driveEToEmail(s);
    ok(s.insertCalls.length === 1 && s.insertCalls[0].extraColumns === undefined, 'E direct arrival: the homeowner insert carries no extra columns');
  }
}

// ---- ledger ------------------------------------------------------------------------------------------------------------------
const ledger = JSON.parse(rd('tests/fixtures/gh2060-storage-surface-ledger.json'));
const entry = (ledger.surfaces || ledger.entries || ledger.keys || (Array.isArray(ledger) ? ledger : [])).find((e) => e.key === 'oq_home_zip');
ok(!!entry && entry.status === 'tested', 'ledger: oq_home_zip is marked `tested` (was write-only)');
ok(!!entry && Array.isArray(entry.tests) && entry.tests.some((t) => t.file === 'tests/gh2598-start-home-zip.mjs' && /STALE STATE/.test(t.contains || '')), 'ledger: oq_home_zip cites this test file and its STALE STATE case');

for (const [label, fn] of [['D', dScenarios], ['E', eScenarios]]) {
  try { await fn(); } catch (e) { ok(false, label + ' scenarios ran to completion (threw: ' + (e && e.message) + ')'); }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
