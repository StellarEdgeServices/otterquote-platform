/**
 * gh-1940 -- Variant D fires GA4 router_contact_submitted at its first
 * commitment (the d-email submit that creates the leads row), exactly once,
 * with the closed {step, step_index} pair only.
 *
 * Before this change arm D fired the Meta Lead at that point but never the GA4
 * event, while arms C/E/F did (gh-2096 item 1): GA4 2026-09-21 -> 2026-10-05
 * had router_contact_submitted c 13, e 28, f 4, d 0 beside 193 d step views.
 *
 * Same harness as tests/gh2075-variant-d.mjs: js/router-variant-d.js is loaded
 * verbatim into a Node `vm` behind a small DOM shim; bridge.sb is stubbed and
 * this suite never writes anywhere. NEGATIVE CONTROL: the same scenarios are
 * run against a mutated copy of the source with the GA4 call removed; the
 * detector scenario must FAIL there (so a pass above is not a dead assertion).
 *
 * Run: node tests/gh1940-arm-d-contact-submitted.mjs
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const variantDSrcReal = fs.readFileSync(path.join(repoRoot, 'js', 'router-variant-d.js'), 'utf8');
// Negative control: the shipped source with the GA4 call neutralised.
const variantDSrcMutant = variantDSrcReal.replace(
  "bridge.trackRouter('router_contact_submitted'", "void ('router_contact_submitted'");

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

// ── Minimal DOM shim -- only what router-variant-d.js / router-discovery.js
// actually call. Not a general-purpose DOM. ──
function makeDom(ctxCell) {
  const registry = {};
  function syncClassName(el) { el.className = el._classes.join(' '); }

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
        // Real DOM semantics: textContent is the concatenation of every
        // descendant text node when children exist (router-variant-d.js
        // builds button labels via appendChild(document.createTextNode(...))
        // + appendChild(el('span', ...)), never by setting .textContent
        // directly on those buttons) -- only fall back to the explicitly
        // set `_text` (the el(tag, class, text) helper's own path) when
        // there are no children.
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
      // gh-2075 round 3: js/router-discovery.js's setRowSelected() calls
      // btn.querySelector('[data-rd-marker]') on a multi-select row's own
      // checkmark span -- only the bracket-attribute-selector form is
      // needed anywhere in either file this suite loads, so that is all
      // this shim supports.
      querySelector(sel) {
        // gh-2075 round 3: two selector shapes are all either file this
        // suite loads ever calls -- [data-rd-marker] (a bracket attribute
        // selector, router-discovery.js's setRowSelected()) and
        // .form-label (a class selector, router-discovery.js's own
        // phone-field-is-optional tweak in renderContact()). Nothing else
        // is supported; this is not a general selector engine.
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
      addEventListener(evt, fn) { (this._listeners[evt] = this._listeners[evt] || []).push(fn); },
      removeEventListener(evt, fn) {
        if (!this._listeners[evt]) return;
        this._listeners[evt] = this._listeners[evt].filter((f) => f !== fn);
      },
      dispatchClick() { (this._listeners.click || []).forEach((fn) => fn({ type: 'click' })); },
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
          // Real <script src>: setting .src starts an async fetch --
          // .onload/.onerror are always attached AFTER .src in real code
          // (see js/router-variant-d.js's own loadDiscoveryModule()), and
          // still fire correctly because the actual load happens later.
          // Deferring this shim's "fetch" to a microtask preserves that
          // ordering; running it synchronously here would fire the load
          // event before .onload is ever assigned, and the caller's
          // Promise would hang forever.
          //
          // ctxCell (not a shared module-level variable) is what makes
          // this safe when several scenarios' async chains interleave:
          // each buildScenario() call gets its OWN ctxCell, filled in
          // once that scenario's vm context exists, so a deferred
          // callback here always injects into the scenario that actually
          // owns this <script> element -- never whichever scenario
          // happened to build ITS OWN context most recently.
          const ctxAtSet = ctxCell.ctx;
          Promise.resolve().then(() => {
            try {
              let code = null;
              if (String(v).indexOf('router-discovery.js') !== -1) code = discoverySrc;
              if (code == null) throw new Error('unstubbed script src in test: ' + v);
              vm.runInContext(code, ctxAtSet, { filename: v });
              if (el._listeners.load) el._listeners.load.forEach((fn) => fn());
            } catch (e) {
              if (el._listeners.error) el._listeners.error.forEach((fn) => fn(e));
              else throw e;
            }
          });
        }
      });
      // router-variant-d.js sets .onload/.onerror directly (not
      // addEventListener) for its OWN script injections -- support both.
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
  return { document, registry };
}


function buildScenario(src, opts) {
  opts = opts || {};
  const ctxCell = {};
  const { document } = makeDom(ctxCell);
  const routerDRoot = document.createElement('div');
  routerDRoot.setAttribute('id', 'routerDRoot');

  const trackedEvents = [];
  const rpcCalls = [];
  const insertCalls = [];
  const redirects = [];
  let nextLeadId = 1;

  const bridge = {
    // gh-2075 round 3 (re-review finding, blocker): supabase-js
    // 2.112.4's `.rpc(...)` returns a then-able with `.then(onFulfilled,
    // onRejected)` but NO `.catch()` -- a bare `.catch()` called directly
    // on it throws `.catch is not a function` in production. A real
    // native Promise.resolve(...) here would NOT have caught that bug
    // (native Promises support .catch everywhere), so this stub wraps it
    // in a then-only object, matching supabase-js's own shape, so this
    // suite fails loudly on any code path that calls `.catch()` directly
    // on an `sb.rpc(...)` result instead of `.then(onFulfilled,
    // onRejected)` or `.then(fn).catch(fn)`.
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
    collectAttribution: () => ({ v: 'd', utm_source: 'fb', fbclid: null }),
    insertFreshLead: (name, email, phone) => {
      insertCalls.push({ name, email, phone });
      if (opts.failInsert) return Promise.reject(new Error('insert failed (test)'));
      const id = 'lead-' + (nextLeadId++);
      return Promise.resolve(id);
    },
    appendParams: (base, obj) => {
      const parts = Object.keys(obj).filter((k) => obj[k]).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
      if (!parts.length) return base;
      return base + (base.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
    },
    redirectTo: (dest, preBuilt) => { redirects.push({ dest, preBuilt }); },
    showError: (msg) => { if (!opts.failInsert) throw new Error('bridge.showError called unexpectedly: ' + msg); },
    ROLE_DESTINATIONS: { homeowner: 'https://app.otterquote.com/get-started', contractor: 'contractor-join.html' },
    PARTNER_INDUSTRY_DESTINATIONS: { re_agent: 'partner-re.html', insurance_agent: 'partner-insurance.html' },
    NO_LEAD_ID_DESTINATIONS: {}
  };

  const leadEvents = [];
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
    fbq: (action, name) => { if (action === 'track' && name === 'Lead') leadEvents.push(true); },
    RegExp
  };
  sandbox.window.document = document;
  const ctx = vm.createContext(sandbox);
  ctxCell.ctx = ctx;
  vm.runInContext(src || variantDSrcReal, ctx, { filename: 'js/router-variant-d.js' });
  const RouterVariantD = ctx.window.RouterVariantD;
  if (!RouterVariantD || typeof RouterVariantD.init !== 'function') {
    throw new Error('window.RouterVariantD.init was not defined after loading js/router-variant-d.js');
  }

  return { ctx, routerDRoot, bridge, RouterVariantD, trackedEvents, rpcCalls, insertCalls, redirects, leadEvents };
}

function flatten(el) {
  // Depth-first flatten -- these two files never nest more than 2-3 levels
  // deep (root -> wrap/group -> button/input), so a small recursive walk
  // is enough to find any element by predicate below.
  const out = [el];
  (el.children || []).forEach((c) => { out.push(...flatten(c)); });
  return out;
}
function findRoleButtons(root) {
  return flatten(root).filter((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('role-option'));
}
function findByTag(root, tag) {
  return flatten(root).filter((c) => c.tagName === tag.toUpperCase() && c !== root);
}
function fillAndSubmit(root, inputId, value) {
  const input = flatten(root).find((ch) => ch.id === inputId);
  input.value = value;
  const submitBtn = flatten(root).find((c) => c.tagName === 'BUTTON' && c.textContent === 'Continue');
  submitBtn.dispatchClick();
}


function tick(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 1); i++) { p = p.then(() => Promise.resolve()); }
  return p;
}
function contactEvents(trackedEvents) {
  return trackedEvents.filter((e) => e.name === 'router_contact_submitted');
}

// Scenario H: homeowner submits the d-email screen -> exactly one
// router_contact_submitted {step:'d-email', step_index:2}, one Meta Lead, and
// the event precedes d-email's own router_step_complete.
async function scenarioHomeowner(src) {
  const { routerDRoot, bridge, RouterVariantD, trackedEvents, insertCalls, leadEvents } = buildScenario(src);
  RouterVariantD.init(bridge, routerDRoot);
  findRoleButtons(routerDRoot)[0].dispatchClick(); // Homeowner
  fillAndSubmit(routerDRoot, 'dEmail', 'jane@example.com');
  await tick(6);
  return { trackedEvents, insertCalls, leadEvents, routerDRoot };
}

// Scenario R: resubmit after Back (typo correction) must not fire a second event.
async function scenarioResubmit(src) {
  const { routerDRoot, bridge, RouterVariantD, trackedEvents, insertCalls, leadEvents } = buildScenario(src);
  RouterVariantD.init(bridge, routerDRoot);
  findRoleButtons(routerDRoot)[0].dispatchClick();
  fillAndSubmit(routerDRoot, 'dEmail', 'typo@example.com');
  await tick(6);
  const backBtn = flatten(routerDRoot).find((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('router-back'));
  backBtn.dispatchClick();
  await tick(2);
  fillAndSubmit(routerDRoot, 'dEmail', 'fixed@example.com');
  await tick(6);
  return { trackedEvents, insertCalls, leadEvents };
}

// Scenario C: contractor role -- terminal at d-email, still one event.
async function scenarioContractor(src) {
  const { routerDRoot, bridge, RouterVariantD, trackedEvents, redirects, leadEvents } = buildScenario(src);
  RouterVariantD.init(bridge, routerDRoot);
  findRoleButtons(routerDRoot)[2].dispatchClick(); // Contractor
  fillAndSubmit(routerDRoot, 'dEmail', 'pro@example.com');
  await tick(6);
  return { trackedEvents, redirects, leadEvents };
}

// Scenario F: the leads insert fails -> no lead was created, so no contact event.
async function scenarioInsertFails(src) {
  const { routerDRoot, bridge, RouterVariantD, trackedEvents, leadEvents } = buildScenario(src, { failInsert: true });
  const origError = console.error; console.error = () => {};
  try {
    RouterVariantD.init(bridge, routerDRoot);
    findRoleButtons(routerDRoot)[0].dispatchClick();
    fillAndSubmit(routerDRoot, 'dEmail', 'jane@example.com');
    await tick(6);
  } finally { console.error = origError; }
  return { trackedEvents, leadEvents };
}

(async function main() {
  // ── shipped source ──
  const h = await scenarioHomeowner();
  const ce = contactEvents(h.trackedEvents);
  ok(h.insertCalls.length === 1, 'homeowner: exactly one leads insert');
  ok(ce.length === 1, 'homeowner: router_contact_submitted fires exactly once');
  ok(ce.length === 1 && ce[0].extra.step === 'd-email' && ce[0].extra.step_index === 2,
    'homeowner: payload is {step:"d-email", step_index:2}');
  ok(ce.length === 1 && Object.keys(ce[0].extra).sort().join(',') === 'step,step_index',
    'homeowner: payload carries ONLY step and step_index (no email, no field value)');
  ok(!JSON.stringify(h.trackedEvents).includes('jane@example.com'), 'homeowner: the typed email appears in no tracked event');
  ok(h.leadEvents.length === 1, 'homeowner: Meta Lead still fires exactly once (unchanged)');
  const names = h.trackedEvents.map((e) => e.name + ':' + (e.extra.step || ''));
  ok(names.indexOf('router_contact_submitted:d-email') !== -1
    && names.indexOf('router_contact_submitted:d-email') < names.indexOf('router_step_complete:d-email'),
    'homeowner: router_contact_submitted precedes d-email router_step_complete');

  const r = await scenarioResubmit();
  ok(r.insertCalls.length === 1, 'resubmit: still one leads insert');
  ok(contactEvents(r.trackedEvents).length === 1, 'resubmit: router_contact_submitted fired once in total, not again on the corrected email');
  ok(r.leadEvents.length === 1, 'resubmit: Meta Lead still once');

  const c = await scenarioContractor();
  ok(contactEvents(c.trackedEvents).length === 1, 'contractor: router_contact_submitted fires once');
  ok(c.redirects.length === 1, 'contractor: hand-off redirect unchanged (one redirect)');
  ok(c.leadEvents.length === 1, 'contractor: Meta Lead once');

  const f = await scenarioInsertFails();
  ok(contactEvents(f.trackedEvents).length === 0, 'insert failure: no router_contact_submitted (no lead row was created)');
  ok(f.leadEvents.length === 0, 'insert failure: no Meta Lead either');

  // ── NEGATIVE CONTROL: same scenario against the mutated source must FAIL the detector ──
  const hm = await scenarioHomeowner(variantDSrcMutant);
  const mutantFires = contactEvents(hm.trackedEvents).length;
  ok(variantDSrcMutant !== variantDSrcReal, 'negative control: the mutation actually changed the source');
  ok(mutantFires === 0, 'negative control: with the GA4 call removed the detector sees 0 router_contact_submitted (the pass above is not a dead assertion)');
  ok(hm.leadEvents.length === 1, 'negative control: the mutant still fires the Meta Lead (only the GA4 call differs)');

  console.log('\n=== Summary ===');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('test error:', e); process.exit(1); });
