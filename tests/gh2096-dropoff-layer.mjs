/**
 * gh-2096 — the C/D/E drop-off layer: Lead on C/E, `step`/`step_index` on
 * every router event, and the shared per-arm STEP_INDEX tables added to
 * js/router-discovery.js, js/router-variant-d.js and js/router-variant-e.js.
 *
 * Same harness philosophy as tests/gh2075-variant-d.mjs and
 * tests/gh2076-variant-e.mjs (see those files' own top comments): no real
 * browser engine / jsdom in this repo, so this drives the ACTUAL files
 * inside a Node `vm` context behind a minimal hand-rolled DOM shim (copied
 * from tests/gh2076-variant-e.mjs's own shim, plus a `fbq` stub that file's
 * sandbox does not define, needed here to assert the NEW Meta Lead calls).
 *
 * Scope: this file covers what gh-2096 ADDS (Lead + router_contact_submitted
 * on C/E, step_index tables and their disqualifier-token mapping). It does
 * NOT re-prove the full existing C/D/E behavior those two files already
 * cover in detail -- both were re-run against this PR's changes and still
 * pass unchanged (104/104 and 57/57 respectively), which is this PR's own
 * non-regression evidence for "Variant C keeps working exactly as it does
 * today" and "no double-count". start.html's own shared trackRouter/
 * insertFreshLead additions (ua_context, lead_id stitching, the abandon
 * beacon) are NOT covered by this file -- start.html's IIFE has no module
 * export and needs a much larger DOM (every #step1/#step2/#step2a/#step3
 * element, both forms) than this repo's existing harnesses build for it;
 * that gap is named in this PR's own report as follow-up.
 *
 * Run: node tests/gh2096-dropoff-layer.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const discoverySrc = fs.readFileSync(path.join(repoRoot, 'js', 'router-discovery.js'), 'utf8');
const variantESrc = fs.readFileSync(path.join(repoRoot, 'js', 'router-variant-e.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

// gh-2096 CLOSE-REVIEW: FAIL (comment 5801804139) regression guard: every
// router_step_complete a walk emits must carry a numeric step_index. Returns
// the offending step tokens so a failure names the screen, not just a count.
function completesMissingStepIndex(trackedEvents) {
  return trackedEvents
    .filter((e) => e.name === 'router_step_complete' && typeof e.extra.step_index !== 'number')
    .map((e) => e.extra.step);
}

// ── Minimal DOM shim -- copied from tests/gh2076-variant-e.mjs's own shim
// (same files, same DOM surface). Not a general-purpose DOM. ──
function makeDom(ctxCell) {
  const registry = {};
  const clockState = { now: 1000000 };
  function syncClassName(el) { el.className = el._classes.join(' '); }

  function dispatchDomEvent(target, type) {
    clockState.now += 1000;
    const chain = [];
    let cur = target;
    while (cur) { chain.push(cur); cur = cur.parentNode; }
    const event = { type: type, preventDefault() {}, stopPropagation() { event._stopped = true; } };
    const capturePath = chain.slice(1).reverse();
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
      dispatchClick() { if (this.disabled) return; dispatchDomEvent(this, 'click'); },
      dispatchEvent(type) { dispatchDomEvent(this, type); },
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
      Object.defineProperty(el, 'onload', { set(fn) { el.addEventListener('load', fn); }, get() { return undefined; } });
      Object.defineProperty(el, 'onerror', { set(fn) { el.addEventListener('error', fn); }, get() { return undefined; } });
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

function flatten(el) {
  const out = [el];
  (el.children || []).forEach((c) => { out.push(...flatten(c)); });
  return out;
}
function findOptionButtons(root) {
  return flatten(root).filter((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('role-option'));
}
function findContinueButton(root) {
  return flatten(root).find((c) => c.tagName === 'BUTTON' && c.textContent === 'Continue');
}
function findNextButton(root) {
  return flatten(root).find((c) => c.tagName === 'BUTTON' && c.textContent === 'Next');
}
function fillAndSubmit(root, inputId, value) {
  const input = flatten(root).find((ch) => ch.id === inputId);
  input.value = value;
  findContinueButton(root).dispatchClick();
}
function settle() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => Promise.resolve());
}
function eventNames(trackedEvents) {
  return trackedEvents.map((e) => e.name + ':' + (e.extra.step != null ? e.extra.step : ''));
}

// ═══════════════════════════════════════════════════════════════════════
// Arm C standalone (js/router-discovery.js driven directly, same pattern
// tests/gh2075-variant-d.mjs's own buildDiscoveryScenario uses).
// ═══════════════════════════════════════════════════════════════════════
function buildDiscoveryScenario() {
  const ctxCell = {};
  const { document } = makeDom(ctxCell);
  const routerCRoot = document.createElement('div');
  routerCRoot.setAttribute('id', 'routerCRoot');

  const trackedEvents = [];
  const rpcCalls = [];
  const insertCalls = [];
  const redirects = [];
  const leadEvents = [];
  let nextLeadId = 1;

  const bridge = {
    get sb() {
      return {
        rpc: (name, args) => {
          rpcCalls.push({ name, args });
          const p = Promise.resolve({ error: null });
          return { then: (onFulfilled, onRejected) => p.then(onFulfilled, onRejected) };
        }
      };
    },
    trackRouter: (name, extra) => { trackedEvents.push({ name, extra: Object.assign({}, extra) }); },
    collectAttribution: () => ({ v: 'c', utm_source: 'fb', fbclid: null }),
    insertFreshLead: (name, email, phone) => {
      insertCalls.push({ name, email, phone });
      const id = 'lead-' + (nextLeadId++);
      return Promise.resolve(id);
    },
    appendParams: (base, obj) => {
      const parts = Object.keys(obj).filter((k) => obj[k]).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
      if (!parts.length) return base;
      return base + (base.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
    },
    redirectTo: (dest, preBuilt) => { redirects.push({ dest, preBuilt }); },
    showError: (msg) => { throw new Error('bridge.showError called unexpectedly: ' + msg); },
    ROLE_DESTINATIONS: { homeowner: 'https://app.otterquote.com/get-started', contractor: 'contractor-join.html' },
    PARTNER_INDUSTRY_DESTINATIONS: {
      re_agent: 'partner-re.html', insurance_agent: 'partner-insurance.html',
      home_inspector: 'partner-inspectors.html', adjuster: 'partner-adjusters.html', other: 'partner-other.html'
    },
    NO_LEAD_ID_DESTINATIONS: {}
  };

  const sandbox = {
    document,
    window: {},
    console,
    Promise,
    setTimeout,
    encodeURIComponent,
    Object,
    Array,
    String,
    URLSearchParams,
    RegExp,
    fbq: (action, name) => { if (action === 'track' && name === 'Lead') leadEvents.push(true); },
    AgentTypes: {
      CHOOSER_LABELS: {
        re_agent: 'Real Estate Agent', insurance_agent: 'Insurance Agent',
        home_inspector: 'Home Inspector', adjuster: 'Adjuster', other: 'Other'
      }
    }
  };
  sandbox.window.document = document;
  sandbox.window.AgentTypes = sandbox.AgentTypes;
  const ctx = vm.createContext(sandbox);
  ctxCell.ctx = ctx;
  vm.runInContext(discoverySrc, ctx, { filename: 'js/router-discovery.js' });
  const RouterDiscovery = ctx.window.RouterDiscovery;
  if (!RouterDiscovery || typeof RouterDiscovery.init !== 'function') {
    throw new Error('window.RouterDiscovery.init was not defined after loading js/router-discovery.js');
  }
  return { routerCRoot, bridge, RouterDiscovery, trackedEvents, rpcCalls, insertCalls, redirects, leadEvents };
}

// Drives c-entry -> homeowner track -> c-home-8 contact screen, filled but
// not yet submitted.
function driveCToHomeContact(routerCRoot) {
  findOptionButtons(routerCRoot)[0].dispatchClick(); // c-entry option 1: homeowner -> c-home-1
  for (let i = 0; i < 3; i++) {
    findContinueButton(routerCRoot) ? findContinueButton(routerCRoot).dispatchClick() : findOptionButtons(routerCRoot)[0].dispatchClick();
  }
}

// Multi-select screens (c-home-2/4/6) start with Continue DISABLED until at
// least one option is toggled (continueButton('Continue', fn) with no 3rd
// arg -- see router-discovery.js's own renderMultiSelect) -- toggle the
// given 0-based option indices, then click Continue.
function pickMultiAndContinue(root, indices) {
  const opts = findOptionButtons(root);
  indices.forEach((i) => opts[i].dispatchClick());
  findContinueButton(root).dispatchClick();
}

const results = [];
results.push((function scenarioC1() {
  const { routerCRoot, bridge, RouterDiscovery, trackedEvents, insertCalls, leadEvents } = buildDiscoveryScenario();
  RouterDiscovery.init(bridge, routerCRoot);
  ok(trackedEvents.length === 1 && trackedEvents[0].extra.step_index === 1, 'c-entry\'s own router_step_view carries step_index: 1');
  findOptionButtons(routerCRoot)[0].dispatchClick(); // homeowner -> c-home-1
  ok(trackedEvents.find((e) => e.name === 'router_step_view' && e.extra.step === 'c-home-1').extra.step_index === 2,
    'c-home-1 carries step_index: 2');
  findContinueButton(routerCRoot).dispatchClick(); // c-home-1 (plain text) -> c-home-2
  pickMultiAndContinue(routerCRoot, [0]); // c-home-2 (multi-select) -> c-home-3
  findOptionButtons(routerCRoot)[0].dispatchClick(); // c-home-3 (single-select) -> c-home-4
  ok(trackedEvents.find((e) => e.name === 'router_step_view' && e.extra.step === 'c-home-4').extra.step_index === 5,
    'c-home-4 carries step_index: 5');
})());

// ═══ Scenario C2: router_disqualified on a c-home-dq-* screen carries the
// SAME step_index as its source screen (via DQ_SOURCE), not a fresh guess.
// ═══
results.push((function scenarioC2() {
  const { routerCRoot, bridge, RouterDiscovery, trackedEvents } = buildDiscoveryScenario();
  RouterDiscovery.init(bridge, routerCRoot);
  findOptionButtons(routerCRoot)[0].dispatchClick(); // homeowner -> c-home-1
  findContinueButton(routerCRoot).dispatchClick(); // -> c-home-2
  pickMultiAndContinue(routerCRoot, [0]); // -> c-home-3
  findOptionButtons(routerCRoot)[0].dispatchClick(); // -> c-home-4
  // c-home-4 qualifies ONLY when the selection is exactly {"None of the
  // above"} (the LAST option) -- picking the FIRST option instead
  // disqualifies, per router-discovery.js's own onContinue for this
  // screen (`chosen.length === 1 && chosen[0] === 5`).
  pickMultiAndContinue(routerCRoot, [0]); // -> c-home-dq-4
  const homeView = trackedEvents.find((e) => e.name === 'router_step_view' && e.extra.step === 'c-home-4');
  const dq = trackedEvents.find((e) => e.name === 'router_disqualified');
  ok(!!dq, 'router_disqualified fires');
  ok(!!dq && !!homeView && dq.extra.step_index === homeView.extra.step_index,
    'router_disqualified\'s step_index matches c-home-4\'s own step_index (both derived from the same STEP_INDEX entry via DQ_SOURCE)');
})());

// ═══ Scenario C3: c-home-8 (homeowner contact) fires router_contact_submitted
// {step:'c-home-8', step_index:9} and Meta Lead exactly once, BEFORE
// router_step_complete:c-home-8. ═══
results.push((function scenarioC3() {
  const { routerCRoot, bridge, RouterDiscovery, trackedEvents, insertCalls, leadEvents } = buildDiscoveryScenario();
  RouterDiscovery.init(bridge, routerCRoot);
  findOptionButtons(routerCRoot)[0].dispatchClick(); // homeowner -> c-home-1
  findContinueButton(routerCRoot).dispatchClick(); // -> c-home-2
  pickMultiAndContinue(routerCRoot, [0]); // -> c-home-3
  findOptionButtons(routerCRoot)[0].dispatchClick(); // -> c-home-4
  pickMultiAndContinue(routerCRoot, [4]); // ONLY "None of the above" -- qualifies -> c-home-5
  findOptionButtons(routerCRoot)[0].dispatchClick(); // option 1 -- qualifies (only option 3 disqualifies) -> c-home-6
  pickMultiAndContinue(routerCRoot, [0]); // "Great Reviews" only -- qualifies (6/7/8 disqualify) -> c-home-7
  findOptionButtons(routerCRoot)[1].dispatchClick(); // option 2 -- qualifies (option 1 disqualifies) -> c-home-8
  ok(!!flatten(routerCRoot).find((c) => c.id === 'rdName'), 'c-home-8 renders the contact form');
  flatten(routerCRoot).find((c) => c.id === 'rdName').value = 'Jamie Homeowner';
  flatten(routerCRoot).find((c) => c.id === 'rdEmail').value = 'jamie@example.com';
  const submitBtn = flatten(routerCRoot).find((c) => c.id === 'rdContactSubmit');
  submitBtn.dispatchClick();
  return settle().then(() => {
    ok(insertCalls.length === 1, 'exactly one leads insert at c-home-8');
    const submitted = trackedEvents.find((e) => e.name === 'router_contact_submitted');
    ok(!!submitted && submitted.extra.step === 'c-home-8' && submitted.extra.step_index === 9,
      'router_contact_submitted fires with {step:"c-home-8", step_index:9}');
    ok(leadEvents.length === 1, 'Meta Lead fires exactly once');
    const submittedIdx = trackedEvents.indexOf(submitted);
    const completeIdx = trackedEvents.findIndex((e) => e.name === 'router_step_complete' && e.extra.step === 'c-home-8');
    ok(submittedIdx < completeIdx, 'router_contact_submitted fires BEFORE router_step_complete:c-home-8, not after');
    ok(trackedEvents.filter((e) => e.name === 'router_contact_submitted').length === 1, 'router_contact_submitted fires exactly once, not once per RPC retry path');
    ok(completesMissingStepIndex(trackedEvents).length === 0,
      'every router_step_complete on the c-home-8 walk carries a numeric step_index (missing: ' + completesMissingStepIndex(trackedEvents).join(',') + ')');
  }).catch((e) => { console.error('scenarioC3 error:', e); fail++; });
})());

// ═══ Scenario C4: the shared renderPartnerContact (contractor track) fires
// router_contact_submitted {step:'c-contractor-contact', step_index:7} +
// Meta Lead exactly once -- proves the fix reaches C's realtor/insurance/
// contractor tracks too, not just the homeowner c-home-8 screen. ═══
results.push((function scenarioC4() {
  const { routerCRoot, bridge, RouterDiscovery, trackedEvents, insertCalls, leadEvents, rpcCalls } = buildDiscoveryScenario();
  RouterDiscovery.init(bridge, routerCRoot);
  findOptionButtons(routerCRoot)[2].dispatchClick(); // c-entry option 3: contractor -> c-contractor-1
  for (let i = 0; i < 4; i++) { findOptionButtons(routerCRoot)[0].dispatchClick(); } // c-contractor-1..4
  findContinueButton(routerCRoot).dispatchClick(); // c-contractor-5 (text) -> c-contractor-contact
  flatten(routerCRoot).find((c) => c.id === 'rdpName').value = 'Cam Contractor';
  flatten(routerCRoot).find((c) => c.id === 'rdpEmail').value = 'cam@example.com';
  findContinueButton(routerCRoot).dispatchClick();
  return settle().then(() => {
    ok(insertCalls.length === 1, 'exactly one leads insert at c-contractor-contact');
    const submitted = trackedEvents.find((e) => e.name === 'router_contact_submitted');
    ok(!!submitted && submitted.extra.step === 'c-contractor-contact' && submitted.extra.step_index === 7,
      'router_contact_submitted fires with {step:"c-contractor-contact", step_index:7}');
    ok(leadEvents.length === 1, 'Meta Lead fires exactly once for the contractor track');
    const roleCall = rpcCalls.find((c) => c.name === 'set_lead_role');
    ok(!!roleCall && roleCall.args.p_role === 'contractor', 'set_lead_role still fires with p_role="contractor", unchanged by this PR');
    const completeC = trackedEvents.find((e) => e.name === 'router_step_complete' && e.extra.step === 'c-contractor-contact');
    ok(!!completeC && completeC.extra.step_index === 7,
      'router_step_complete for c-contractor-contact carries step_index 7');
    ok(completesMissingStepIndex(trackedEvents).length === 0,
      'every router_step_complete on the C contractor walk carries a numeric step_index (missing: ' + completesMissingStepIndex(trackedEvents).join(',') + ')');
  }).catch((e) => { console.error('scenarioC4 error:', e); fail++; });
})());

// ═══════════════════════════════════════════════════════════════════════
// Arm E (js/router-variant-e.js, which lazy-loads js/router-discovery.js
// at its own init() -- same buildScenario shape as tests/gh2076-variant-e.mjs,
// with `fbq` added to the sandbox so Meta Lead is observable here).
// ═══════════════════════════════════════════════════════════════════════
function buildEScenario() {
  const ctxCell = {};
  const { document, clockState } = makeDom(ctxCell);
  const routerERoot = document.createElement('div');
  routerERoot.setAttribute('id', 'routerERoot');

  const trackedEvents = [];
  const rpcCalls = [];
  const insertCalls = [];
  const redirects = [];
  const leadEvents = [];
  let nextLeadId = 1;

  const bridge = {
    get sb() {
      return {
        rpc: (name, args) => {
          rpcCalls.push({ name, args });
          const p = Promise.resolve({ data: true, error: null });
          return { then: (onFulfilled, onRejected) => p.then(onFulfilled, onRejected) };
        }
      };
    },
    trackRouter: (name, extra) => { trackedEvents.push({ name, extra: Object.assign({}, extra) }); },
    collectAttribution: () => ({ v: 'e', utm_source: 'fb', fbclid: null }),
    insertFreshLead: (name, email, phone, isSynthetic) => {
      insertCalls.push({ name, email, phone, isSynthetic: !!isSynthetic });
      const id = 'lead-' + (nextLeadId++);
      return Promise.resolve(id);
    },
    appendParams: (base, obj) => {
      const parts = Object.keys(obj).filter((k) => obj[k]).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
      if (!parts.length) return base;
      return base + (base.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
    },
    redirectTo: (dest, preBuilt) => { redirects.push({ dest, preBuilt }); },
    showError: (msg) => { throw new Error('bridge.showError called unexpectedly: ' + msg); },
    ROLE_DESTINATIONS: { homeowner: 'https://app.otterquote.com/get-started', contractor: 'contractor-join.html' },
    PARTNER_INDUSTRY_DESTINATIONS: {
      re_agent: 'partner-re.html', insurance_agent: 'partner-insurance.html',
      home_inspector: 'partner-inspectors.html', adjuster: 'partner-adjusters.html', other: 'partner-other.html'
    },
    NO_LEAD_ID_DESTINATIONS: {},
    oqInternalOverride: false
  };

  const windowListeners = {};
  const sandbox = {
    document,
    window: {
      addEventListener(evt, fn) { (windowListeners[evt] = windowListeners[evt] || []).push(fn); },
      removeEventListener(evt, fn) {
        if (!windowListeners[evt]) return;
        windowListeners[evt] = windowListeners[evt].filter((f) => f !== fn);
      },
      dispatchPageshow(persisted) { (windowListeners.pageshow || []).forEach((fn) => fn({ persisted: persisted })); }
    },
    console,
    Promise,
    setTimeout,
    encodeURIComponent,
    Object,
    Array,
    String,
    URLSearchParams,
    RegExp,
    fbq: (action, name) => { if (action === 'track' && name === 'Lead') leadEvents.push(true); },
    AgentTypes: undefined,
    Date: { now: () => clockState.now }
  };
  sandbox.window.document = document;
  sandbox.window.AgentTypes = {
    CHOOSER_LABELS: {
      re_agent: 'Real Estate Agent', insurance_agent: 'Insurance Agent',
      home_inspector: 'Home Inspector', adjuster: 'Adjuster', other: 'Other'
    }
  };
  const ctx = vm.createContext(sandbox);
  ctxCell.ctx = ctx;
  vm.runInContext(variantESrc, ctx, { filename: 'js/router-variant-e.js' });
  const RouterVariantE = ctx.window.RouterVariantE;
  if (!RouterVariantE || typeof RouterVariantE.init !== 'function') {
    throw new Error('window.RouterVariantE.init was not defined after loading js/router-variant-e.js');
  }
  return { routerERoot, bridge, RouterVariantE, trackedEvents, rpcCalls, insertCalls, redirects, leadEvents };
}

function driveEToP5(routerERoot) {
  return settle().then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // Homeowner
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p2 -> e-p3
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // Me -> e-p4a
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p4a -> e-p5
    return settle();
  });
}
function driveEToP7_5(routerERoot) {
  return driveEToP5(routerERoot).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick();
    findContinueButton(routerERoot).dispatchClick(); // e-p5 -> e-p5-5
    return settle();
  }).then(() => {
    fillAndSubmit(routerERoot, 'eName', 'Jane Smith'); // e-p5-5 -> e-p6
    return settle();
  }).then(() => {
    const rows = findOptionButtons(routerERoot);
    rows[4].dispatchClick(); // "None of the above" -- qualifies -> e-p7
    findContinueButton(routerERoot).dispatchClick();
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p7 -> e-p7-5
    return settle();
  });
}

// ═══ Scenario E1: e-p7-5 (homeowner's first commitment) fires
// router_contact_submitted {step:'e-p7-5', step_index:9} + Meta Lead
// exactly once -- and finishing the walk at e-p13 does NOT fire a second
// Lead (e-p13 only PATCHes phone; the row/Lead already exist). ═══
results.push((function scenarioE1() {
  const { routerERoot, bridge, RouterVariantE, trackedEvents, insertCalls, leadEvents, redirects } = buildEScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveEToP7_5(routerERoot).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'jane@example.com');
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'exactly one leads insert, at e-p7-5');
    const submitted = trackedEvents.find((e) => e.name === 'router_contact_submitted');
    ok(!!submitted && submitted.extra.step === 'e-p7-5' && submitted.extra.step_index === 9,
      'router_contact_submitted fires with {step:"e-p7-5", step_index:9}');
    ok(leadEvents.length === 1, 'Meta Lead fires exactly once at e-p7-5');
    // Finish the walk: e-p8 (not the disqualifying option) -> e-p9 -> e-p10
    // (no disqualifying choice) -> e-p11 -> e-p12 (qualifying) -> e-p13.
    findOptionButtons(routerERoot)[1].dispatchClick(); // e-p8 option 2 -- qualifies
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p9 exposition -> e-p10
    return settle();
  }).then(() => {
    // e-p10 is a multi-select (RD.renderMultiSelect) -- its Continue starts
    // DISABLED until at least one option is toggled (same shared function
    // C's own c-home-6 uses). Option 1 ("Great Reviews") is safe: only
    // options 6/7/8 (1-based) disqualify.
    findOptionButtons(routerERoot)[0].dispatchClick();
    findContinueButton(routerERoot).dispatchClick(); // e-p10 -> e-p11
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p11 exposition -> e-p12
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // e-p12 option 2 -- qualifies -> e-p13
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p13, blank phone -> finish
    return settle();
  }).then(() => {
    ok(redirects.length === 1, 'exactly one redirect, at e-p13');
    ok(leadEvents.length === 1, 'Meta Lead is STILL exactly 1 after e-p13 finishes -- no second fire on the phone-only PATCH screen');
    ok(trackedEvents.filter((e) => e.name === 'router_contact_submitted').length === 1,
      'router_contact_submitted fires exactly once for the whole homeowner walk, not again at e-p13');
  }).catch((e) => { console.error('scenarioE1 error:', e); fail++; });
})());

// ═══ Scenario E2: professional/realtor branch -- router_contact_submitted
// fires at e-pro-9-5a (the branch's own first commitment), not at the
// e-pro-12a close/hand-off screen, and Lead fires exactly once across both. ═══
results.push((function scenarioE2() {
  const { routerERoot, bridge, RouterVariantE, trackedEvents, insertCalls, leadEvents, redirects } = buildEScenario();
  RouterVariantE.init(bridge, routerERoot);
  return settle().then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // professional -> e-pro-2
    return settle();
  }).then(() => {
    findNextButton(routerERoot).dispatchClick(); // e-pro-2 -> e-pro-3
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // re_agent -> e-pro-4a
    return settle();
  }).then(() => {
    findNextButton(routerERoot).dispatchClick(); // e-pro-4a -> e-pro-5a
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // e-pro-5a -> e-pro-5-5a (name)
    return settle();
  }).then(() => {
    fillAndSubmit(routerERoot, 'eProName', 'Pat Realtor'); // -> e-pro-6a
    return settle();
  }).then(() => {
    findNextButton(routerERoot).dispatchClick(); // -> e-pro-7a
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // -> e-pro-8a
    return settle();
  }).then(() => {
    findNextButton(routerERoot).dispatchClick(); // -> e-pro-9a
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // -> e-pro-9-5a (email, first commitment)
    return settle();
  }).then(() => {
    fillAndSubmit(routerERoot, 'eProEmail', 'pat@example.com');
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'exactly one leads insert, at e-pro-9-5a');
    const submitted = trackedEvents.find((e) => e.name === 'router_contact_submitted');
    ok(!!submitted && submitted.extra.step === 'e-pro-9-5a' && submitted.extra.step_index === 11,
      'router_contact_submitted fires with {step:"e-pro-9-5a", step_index:11}');
    ok(leadEvents.length === 1, 'Meta Lead fires exactly once at e-pro-9-5a');
    findNextButton(routerERoot).dispatchClick(); // e-pro-10a (exposition) -> e-pro-11a
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // e-pro-11a (question) -> e-pro-12a
    return settle();
  }).then(() => {
    findNextButton(routerERoot).dispatchClick(); // e-pro-12a's own submit -- PATCH + redirect
    return settle();
  }).then(() => {
    ok(redirects.length === 1 && redirects[0].dest.indexOf('partner-re.html') !== -1, 'hand-off redirects to partner-re.html');
    ok(leadEvents.length === 1, 'Meta Lead is STILL exactly 1 after the e-pro-12a hand-off -- no second fire on the close screen');
    ok(trackedEvents.filter((e) => e.name === 'router_contact_submitted').length === 1,
      'router_contact_submitted fires exactly once for the whole realtor branch, not again at e-pro-12a');
  }).catch((e) => { console.error('scenarioE2 error:', e); fail++; });
})());

// ═══ Scenario E3: contractor track (via router-discovery.js's SHARED
// renderPartnerContact) fires router_contact_submitted
// {step:'e-contractor-contact', step_index:7} + Meta Lead exactly once. ═══
results.push((function scenarioE3() {
  const { routerERoot, bridge, RouterVariantE, trackedEvents, insertCalls, leadEvents, redirects, rpcCalls } = buildEScenario();
  RouterVariantE.init(bridge, routerERoot);
  return settle().then(() => {
    findOptionButtons(routerERoot)[2].dispatchClick(); // Contractor
    return settle();
  }).then(() => {
    for (let i = 0; i < 4; i++) { findOptionButtons(routerERoot)[0].dispatchClick(); }
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-contractor-5 -> e-contractor-contact
    return settle();
  }).then(() => {
    flatten(routerERoot).find((c) => c.id === 'rdpName').value = 'Cam Contractor';
    flatten(routerERoot).find((c) => c.id === 'rdpEmail').value = 'cam@contractor.example.com';
    findContinueButton(routerERoot).dispatchClick();
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'exactly one leads insert at e-contractor-contact');
    const submitted = trackedEvents.find((e) => e.name === 'router_contact_submitted');
    ok(!!submitted && submitted.extra.step === 'e-contractor-contact' && submitted.extra.step_index === 7,
      'router_contact_submitted fires with {step:"e-contractor-contact", step_index:7}');
    ok(leadEvents.length === 1, 'Meta Lead fires exactly once for the contractor track');
    const roleCall = rpcCalls.find((c) => c.name === 'set_lead_role');
    ok(!!roleCall && roleCall.args.p_role === 'contractor', 'set_lead_role still fires with p_role="contractor", unchanged');
    ok(redirects.length === 1 && redirects[0].dest.indexOf('contractor-join.html') !== -1, 'redirects to contractor-join.html, unchanged');
    // gh-2096 CLOSE-REVIEW: FAIL (5801804139): E renders this screen through
    // C's shared renderPartnerContact, whose emitComplete looked the token
    // up in C's STEP_INDEX and dropped step_index for 'e-contractor-contact'.
    const completeE = trackedEvents.find((e) => e.name === 'router_step_complete' && e.extra.step === 'e-contractor-contact');
    ok(!!completeE && completeE.extra.step_index === 7,
      'router_step_complete for e-contractor-contact carries step_index 7');
    ok(completesMissingStepIndex(trackedEvents).length === 0,
      'every router_step_complete on the E contractor walk carries a numeric step_index (missing: ' + completesMissingStepIndex(trackedEvents).join(',') + ')');
  }).catch((e) => { console.error('scenarioE3 error:', e); fail++; });
})());

// ═══ Scenario E4: a disqualifier screen (e-dq-p6) carries the SAME
// step_index as its source (e-p6), via DQ_SOURCE, not a hand-guessed number. ═══
results.push((function scenarioE4() {
  const { routerERoot, bridge, RouterVariantE, trackedEvents } = buildEScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveEToP5(routerERoot).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick();
    findContinueButton(routerERoot).dispatchClick(); // e-p5 -> e-p5-5
    return settle();
  }).then(() => {
    fillAndSubmit(routerERoot, 'eName', 'Jane Smith'); // -> e-p6
    return settle();
  }).then(() => {
    const p6View = trackedEvents.find((e) => e.name === 'router_step_view' && e.extra.step === 'e-p6');
    // Choose a disqualifying combination on e-p6 (anything other than
    // ONLY "None of the above") -- option 1 alone disqualifies.
    findOptionButtons(routerERoot)[0].dispatchClick();
    findContinueButton(routerERoot).dispatchClick(); // -> e-dq-p6
    return settle();
  }).then(() => {
    const p6View = trackedEvents.find((e) => e.name === 'router_step_view' && e.extra.step === 'e-p6');
    const dqView = trackedEvents.find((e) => e.name === 'router_step_view' && e.extra.step === 'e-dq-p6');
    ok(!!p6View && !!dqView && p6View.extra.step_index === dqView.extra.step_index,
      'e-dq-p6\'s step_index matches e-p6\'s own step_index (' + (p6View && p6View.extra.step_index) + ')');
  }).catch((e) => { console.error('scenarioE4 error:', e); fail++; });
})());

// Every scenario's own promise (or `undefined` for the two purely
// synchronous ones, C1/C2) is collected in `results` above -- Promise.all
// waits for every one of them, however deeply chained, rather than a
// fixed number of settle() turns that a long scenario chain could still
// be mid-flight past.
Promise.all(results).then(() => {
  console.log('\n=== Summary ===');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
});
