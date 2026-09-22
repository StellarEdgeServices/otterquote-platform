/**
 * gh-2076 (D-327) — Variant E: role-first, arm C's own screens, with the
 * homeowner path led by a short exposition screen before each question.
 *
 * Same harness philosophy as tests/gh2033-variant-assignment.mjs and
 * tests/gh2075-variant-d.mjs: no real browser engine / jsdom in this repo,
 * so this drives the ACTUAL files (js/router-variant-e.js and
 * js/router-discovery.js, which router-variant-e.js loads at its own
 * init()) inside a Node `vm` context behind the same minimal hand-rolled
 * DOM shim tests/gh2075-variant-d.mjs already built.
 *
 * bridge.sb (Supabase) is stubbed, NEVER real, and the Supabase host is
 * never touched — this suite asserts on the INSERT/RPC PAYLOADS the
 * module would have sent, not on a live leads row. No real database
 * write ever happens from this file.
 *
 * Run: node tests/gh2076-variant-e.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const variantESrc = fs.readFileSync(path.join(repoRoot, 'js', 'router-variant-e.js'), 'utf8');
const discoverySrc = fs.readFileSync(path.join(repoRoot, 'js', 'router-discovery.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

// ── Minimal DOM shim -- only what router-variant-e.js / router-discovery.js
// actually call. Copied from tests/gh2075-variant-d.mjs's own shim
// (same two files touch the same DOM surface). Not a general-purpose DOM. ──
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
              if (el._listeners.load) el._listeners.load.forEach((fn) => fn());
            } catch (e) {
              if (el._listeners.error) el._listeners.error.forEach((fn) => fn(e));
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
  return { document, registry };
}

function buildScenario() {
  const ctxCell = {};
  const { document } = makeDom(ctxCell);
  const routerERoot = document.createElement('div');
  routerERoot.setAttribute('id', 'routerERoot');

  const trackedEvents = [];
  const rpcCalls = [];
  const insertCalls = [];
  const redirects = [];
  let nextLeadId = 1;

  const bridge = {
    // Then-only stub, matching supabase-js 2.112.4's real `.rpc(...)`
    // shape (a thenable with `.then(onFulfilled, onRejected)` but NO
    // `.catch()` of its own) -- see tests/gh2075-variant-d.mjs's own
    // comment on why this is deliberate: it makes this suite fail loudly
    // on any code path that calls `.catch()` directly on an `sb.rpc(...)`
    // result instead of going through `.then(...)` first.
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
    collectAttribution: () => ({ v: 'e', utm_source: 'fb', fbclid: null }),
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
      re_agent: 'partner-re.html',
      insurance_agent: 'partner-insurance.html',
      home_inspector: 'partner-inspectors.html',
      adjuster: 'partner-adjusters.html',
      other: 'partner-other.html'
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
    AgentTypes: undefined
  };
  sandbox.window.document = document;
  sandbox.window.AgentTypes = {
    CHOOSER_LABELS: {
      re_agent: 'Real Estate Agent',
      insurance_agent: 'Insurance Agent',
      home_inspector: 'Home Inspector',
      adjuster: 'Adjuster',
      other: 'Other'
    }
  };
  const ctx = vm.createContext(sandbox);
  ctxCell.ctx = ctx;
  vm.runInContext(variantESrc, ctx, { filename: 'js/router-variant-e.js' });
  const RouterVariantE = ctx.window.RouterVariantE;
  if (!RouterVariantE || typeof RouterVariantE.init !== 'function') {
    throw new Error('window.RouterVariantE.init was not defined after loading js/router-variant-e.js');
  }

  return { ctx, routerERoot, bridge, RouterVariantE, trackedEvents, rpcCalls, insertCalls, redirects };
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
function fillAndSubmit(root, inputId, value) {
  const input = flatten(root).find((ch) => ch.id === inputId);
  input.value = value;
  findContinueButton(root).dispatchClick();
}
// Waits several microtask turns -- enough for the vm-shim script-load
// chain (script.src setter -> Promise.resolve().then(...) -> vm.runInContext
// -> onload) plus any then-chains in the module under test to settle.
function settle() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => Promise.resolve());
}
function stepNames(trackedEvents) {
  return trackedEvents.map((e) => e.name + ':' + (e.extra.step || e.extra.role || ''));
}

// ═══ Scenario 1: init() lazy-loads js/router-discovery.js, then renders
// e-p1 with arm C's own entry copy verbatim, 3 tap targets ═══
(function scenario1() {
  const { routerERoot, bridge, RouterVariantE, trackedEvents } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  ok(routerERoot.children.length === 0, 'nothing renders before js/router-discovery.js resolves');
  return settle().then(() => {
    const buttons = findOptionButtons(routerERoot);
    ok(buttons.length === 3, 'e-p1 renders exactly 3 tap targets (arm C\'s own c-entry options)');
    ok(buttons[0].textContent.indexOf('I am a homeowner') !== -1, 'option 1 is arm C\'s homeowner copy, verbatim');
    ok(buttons[1].textContent.indexOf('I am a professional') !== -1, 'option 2 is arm C\'s professional copy, verbatim');
    ok(buttons[2].textContent.indexOf('I am a contractor') !== -1, 'option 3 is arm C\'s contractor copy, verbatim');
    ok(trackedEvents.length === 1 && trackedEvents[0].name === 'router_step_view' && trackedEvents[0].extra.step === 'e-p1',
      'router_step_view {step: "e-p1"} fires on view');
  }).catch((e) => { console.error('scenario1 error:', e); fail++; });
})();

// ═══ Scenario 2: homeowner tap -> e-p2 exposition, Dustin's page-2 copy
// verbatim, single Continue, no question asked yet ═══
(function scenario2() {
  const { routerERoot, bridge, RouterVariantE, trackedEvents } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return settle().then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // Homeowner
    return settle();
  }).then(() => {
    ok(stepNames(trackedEvents).slice(0, 3).join('|') === 'router_step_view:e-p1|router_step_complete:e-p1|router_step_view:e-p2',
      'e-p1 -> e-p2 emits view/complete/view in order (no role-tap event expected -- #2076 reuses arm C\'s c-entry, which does not emit one)');
    const text = flatten(routerERoot).find((c) => c.tagName === 'P');
    ok(!!text && text.textContent.indexOf('Otter Quotes helps homeowners get better deals') !== -1, 'e-p2 renders #2076\'s page-2 exposition copy verbatim');
    ok(!!findContinueButton(routerERoot), 'e-p2 has a Continue button');
    ok(flatten(routerERoot).filter((c) => c.tagName === 'INPUT').length === 0, 'e-p2 asks no question -- exposition only');
  }).catch((e) => { console.error('scenario2 error:', e); fail++; });
})();

// ═══ Scenario 3: e-p3 (arm C's home3, "who is paying") branches Me -> e-p4a,
// Insurance -> e-p4b, each with the matching exposition text ═══
(function scenario3() {
  const { routerERoot, bridge, RouterVariantE } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return settle().then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // Homeowner -> e-p2
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p2 -> e-p3
    return settle();
  }).then(() => {
    const buttons = findOptionButtons(routerERoot);
    ok(buttons.length === 2 && buttons[0].textContent.indexOf('Me') !== -1 && buttons[1].textContent.indexOf('Insurance') !== -1,
      'e-p3 renders arm C\'s home3Options verbatim: Me, Insurance');
    buttons[0].dispatchClick(); // Me -> e-p4a
    return settle();
  }).then(() => {
    const text = flatten(routerERoot).find((c) => c.tagName === 'P');
    ok(text.textContent.indexOf('When multiple contractors know they are bidding') !== -1, 'choosing "Me" renders page 4(a)\'s exposition text');
  }).catch((e) => { console.error('scenario3 error:', e); fail++; });
})();

(function scenario3b() {
  const { routerERoot, bridge, RouterVariantE } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return settle().then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick();
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick();
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // Insurance -> e-p4b
    return settle();
  }).then(() => {
    const text = flatten(routerERoot).find((c) => c.tagName === 'P');
    ok(text.textContent.indexOf('Contractors discourage homeowners from shopping around') !== -1, 'choosing "Insurance" renders page 4(b)\'s exposition text');
  }).catch((e) => { console.error('scenario3b error:', e); fail++; });
})();

// Helper: drives Homeowner -> e-p2 -> e-p3(Me) -> e-p4a -> e-p5 and returns
// once e-p5 (arm C's home2 multi-select) is on screen.
function driveToP5(routerERoot) {
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

// ═══ Scenario 4: e-p5 (home2 multi-select) -> e-p5.5 (name, NEW, no
// leads insert yet) ═══
(function scenario4() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, trackedEvents } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToP5(routerERoot).then(() => {
    const buttons = findOptionButtons(routerERoot);
    ok(buttons.length === 5, 'e-p5 renders arm C\'s home2Options (5 trades)');
    buttons[0].dispatchClick(); // toggle "Roofing"
    findContinueButton(routerERoot).dispatchClick();
    return settle();
  }).then(() => {
    const nameInput = flatten(routerERoot).find((c) => c.id === 'eName');
    ok(!!nameInput, 'e-p5-5 renders exactly one name input');
    ok(flatten(routerERoot).filter((c) => c.tagName === 'INPUT').length === 1, 'e-p5-5 has ONE input (name only)');
    ok(insertCalls.length === 0, 'no leads row is written yet at e-p5-5 -- #2076: the row is written at 7.5');
    ok(stepNames(trackedEvents).indexOf('router_step_view:e-p5-5') !== -1, 'router_step_view fires for e-p5-5');
  }).catch((e) => { console.error('scenario4 error:', e); fail++; });
})();

// ═══ Scenario 5: e-p5.5 (name) -> e-p6 (home4 hidden-costs) -> qualifying
// answer -> e-p7 exposition -> e-p7.5 (email) -- FIRST leads insert,
// carrying the NAME already captured at 5.5 ═══
function driveToP7_5(routerERoot, insertCalls) {
  return driveToP5(routerERoot).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick();
    findContinueButton(routerERoot).dispatchClick(); // e-p5 -> e-p5-5
    return settle();
  }).then(() => {
    fillAndSubmit(routerERoot, 'eName', 'Jane Smith'); // e-p5-5 -> e-p6
    return settle();
  }).then(() => {
    // e-p6: choose ONLY "None of the above" (option 5) -- qualifies.
    const rows = findOptionButtons(routerERoot);
    rows[4].dispatchClick();
    findContinueButton(routerERoot).dispatchClick(); // -> e-p7 (qualifies, no dq)
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p7 -> e-p7-5
    return settle();
  });
}
(function scenario5() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, rpcCalls, trackedEvents } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    const emailInput = flatten(routerERoot).find((c) => c.id === 'eEmail');
    ok(!!emailInput, 'e-p7-5 renders exactly one email input');
    fillAndSubmit(routerERoot, 'eEmail', 'jane@example.com');
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'exactly one leads insert, at e-p7-5');
    ok(insertCalls[0].name === 'Jane Smith' && insertCalls[0].email === 'jane@example.com' && insertCalls[0].phone === null,
      'the insert carries the NAME already captured at e-p5-5 alongside the email -- #2076\'s own split contact capture');
    const roleCall = rpcCalls.find((c) => c.name === 'set_lead_role');
    ok(!!roleCall && roleCall.args.p_role === 'homeowner', 'set_lead_role is called with p_role="homeowner" right after the insert');
    ok(stepNames(trackedEvents).indexOf('router_step_view:e-p8') !== -1, 'router_step_view fires for e-p8 next');
  }).catch((e) => { console.error('scenario5 error:', e); fail++; });
})();

// ═══ Scenario 6: e-p6 disqualifying answer (anything but "None of the
// above" alone) -> e-dq-p6 -> Continue -> e-p7, router_disqualified fires
// once, tagged with the SOURCE screen (e-p6), not the dq screen ═══
(function scenario6() {
  const { routerERoot, bridge, RouterVariantE, trackedEvents } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToP5(routerERoot).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick();
    findContinueButton(routerERoot).dispatchClick(); // -> e-p5-5
    return settle();
  }).then(() => {
    fillAndSubmit(routerERoot, 'eName', 'Jane Smith'); // -> e-p6
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // "Marketing expenses" -- disqualifying
    findContinueButton(routerERoot).dispatchClick(); // -> e-dq-p6
    return settle();
  }).then(() => {
    const text = flatten(routerERoot).find((c) => c.tagName === 'P');
    ok(text.textContent.indexOf('Otter Quotes is designed for homeowners who are trying to avoid the unnecessary costs') !== -1,
      'e-dq-p6 renders arm C\'s dq4Text verbatim');
    ok(trackedEvents.filter((e) => e.name === 'router_disqualified').length === 1, 'router_disqualified fires exactly once');
    ok(trackedEvents.find((e) => e.name === 'router_disqualified').extra.step === 'e-p6', 'router_disqualified carries the SOURCE screen token (e-p6), not e-dq-p6');
    findOptionButtons(routerERoot)[0].dispatchClick(); // the dq screen's own single option row
    return settle();
  }).then(() => {
    const text = flatten(routerERoot).find((c) => c.tagName === 'P');
    ok(text.textContent.indexOf('Otter Quotes get contractors jobs without the need for a marketing budget') !== -1,
      'Continuing from e-dq-p6 advances to e-p7 (Dustin\'s page-7 exposition)');
  }).catch((e) => { console.error('scenario6 error:', e); fail++; });
})();

// ═══ Scenario 7: resubmit-after-Back at e-p7-5 reuses the existing lead
// id -- update_lead_contact, NOT a second insertFreshLead -- and never
// calls a bare `.catch()` on the rpc() thenable (the then-only stub would
// throw if it did) ═══
(function scenario7() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, rpcCalls } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'typo@example.com'); // e-p7-5 -> e-p8, leadId now set
    return settle();
  }).then(() => {
    // Back to e-p7-5 (module-owned stack, not browser history) and correct it.
    const backBtn = flatten(routerERoot).find((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('router-back'));
    backBtn.dispatchClick();
    return settle();
  }).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'corrected@example.com');
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'still exactly ONE leads insert after Back + resubmit -- no duplicate row/admin alert');
    const patchCall = rpcCalls.find((c) => c.name === 'update_lead_contact' && c.args.p_email === 'corrected@example.com');
    ok(!!patchCall, 'the resubmit PATCHes the existing lead via update_lead_contact with the corrected email');
    ok(patchCall.args.p_name === 'Jane Smith', 'the patch carries the name already captured at e-p5-5');
  }).catch((e) => { console.error('scenario7 error:', e); fail++; });
})();

// ═══ Scenario 8: double-tap guard at e-p7-5 -- two rapid clicks before the
// insert resolves must not produce two inserts ═══
(function scenario8() {
  const { routerERoot, bridge, RouterVariantE, insertCalls } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    const input = flatten(routerERoot).find((c) => c.id === 'eEmail');
    input.value = 'jane@example.com';
    const btn = findContinueButton(routerERoot);
    btn.dispatchClick();
    btn.dispatchClick(); // second tap before the first insert's promise settles
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'a rapid double-tap on e-p7-5\'s Continue produces exactly ONE leads insert');
  }).catch((e) => { console.error('scenario8 error:', e); fail++; });
})();

// ═══ Scenario 9: e-p8 (home5) disqualifying option -> e-dq-p8 -> e-p9
// (Dustin's 15-minutes exposition) -> e-p10 (home6) disqualifying
// selection -> e-dq-p10 -> e-p11 (40% exposition) -> e-p12 (home7)
// disqualifying option -> e-dq-p12 -> e-p13 ═══
(function scenario9() {
  const { routerERoot, bridge, RouterVariantE, trackedEvents, rpcCalls } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, []).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'jane@example.com'); // -> e-p8
    return settle();
  }).then(() => {
    const opts = findOptionButtons(routerERoot);
    ok(opts.length === 3, 'e-p8 renders arm C\'s home5Options (3 choices)');
    opts[2].dispatchClick(); // "I love sitting at my kitchen table..." -- disqualifies
    return settle();
  }).then(() => {
    ok(stepNames(trackedEvents).indexOf('router_step_view:e-dq-p8') !== -1, 'e-p8\'s disqualifying option routes to e-dq-p8');
    findOptionButtons(routerERoot)[0].dispatchClick(); // dq's own single continue row
    return settle();
  }).then(() => {
    const text = flatten(routerERoot).find((c) => c.tagName === 'P');
    ok(text.textContent.indexOf('A typical sales call with a contractor takes about two hours or more') !== -1, 'e-p9 renders Dustin\'s page-9 exposition verbatim');
    findContinueButton(routerERoot).dispatchClick(); // -> e-p10
    return settle();
  }).then(() => {
    const rows = findOptionButtons(routerERoot);
    ok(rows.length === 9, 'e-p10 renders arm C\'s home6Options (9 choices)');
    rows[5].dispatchClick(); // option 6 -- disqualifying
    findContinueButton(routerERoot).dispatchClick();
    return settle();
  }).then(() => {
    ok(stepNames(trackedEvents).indexOf('router_step_view:e-dq-p10') !== -1, 'e-p10\'s disqualifying selection routes to e-dq-p10');
    findOptionButtons(routerERoot)[0].dispatchClick();
    return settle();
  }).then(() => {
    const text = flatten(routerERoot).find((c) => c.tagName === 'P');
    ok(text.textContent.indexOf('Nearly 40% of the cost of your roof') !== -1, 'e-p11 renders Dustin\'s page-11 exposition verbatim');
    findContinueButton(routerERoot).dispatchClick(); // -> e-p12
    return settle();
  }).then(() => {
    const opts = findOptionButtons(routerERoot);
    ok(opts.length === 2, 'e-p12 renders arm C\'s home7Options (2 choices)');
    opts[0].dispatchClick(); // option 1 disqualifies (D-2, same as arms C/D)
    return settle();
  }).then(() => {
    ok(stepNames(trackedEvents).indexOf('router_step_view:e-dq-p12') !== -1, 'e-p12 option 1 routes to e-dq-p12');
    findOptionButtons(routerERoot)[0].dispatchClick();
    return settle();
  }).then(() => {
    const bodyPs = flatten(routerERoot).filter((c) => c.tagName === 'P');
    ok(bodyPs.some((p) => p.textContent.indexOf('From our stand point, it seems like you would be a good fit') !== -1),
      'e-p13 renders arm C\'s home8Text verbatim');
    const inputs = flatten(routerERoot).filter((c) => c.tagName === 'INPUT');
    ok(inputs.length === 1 && inputs[0].id === 'ePhone', 'e-p13 collects ONLY phone -- name/email are already on the lead row from e-p7-5');
    findContinueButton(routerERoot).dispatchClick(); // blank phone, optional -- must not block
    return settle();
  }).then(() => {
    const patchCall = rpcCalls.filter((c) => c.name === 'update_lead_contact').pop();
    ok(!!patchCall && patchCall.args.p_phone === null, 'e-p13\'s blank/optional phone PATCHes with p_phone=null, does not block Continue');
  }).catch((e) => { console.error('scenario9 error:', e); fail++; });
})();

// ═══ Scenario 10: e-p13 redirects to ROLE_DESTINATIONS.homeowner with the
// lead id, preBuilt=true (never a second insert) ═══
(function scenario10() {
  const { routerERoot, bridge, RouterVariantE, redirects, insertCalls } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'jane@example.com'); // e-p7-5 -> e-p8
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // e-p8 option 2 -- qualifies -> e-p9
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p9 -> e-p10
    return settle();
  }).then(() => {
    // e-p10: pick a non-disqualifying option (e.g. "Price", index 9) then continue.
    findOptionButtons(routerERoot)[8].dispatchClick();
    findContinueButton(routerERoot).dispatchClick(); // -> e-p11
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p11 -> e-p12
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // e-p12 option 2 -- qualifies -> e-p13
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p13, blank phone
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'exactly one leads insert across the entire homeowner run');
    ok(redirects.length === 1, 'exactly one redirect, at e-p13');
    ok(redirects[0].dest.indexOf('app.otterquote.com/get-started') !== -1, 'homeowner redirects to ROLE_DESTINATIONS.homeowner');
    ok(redirects[0].dest.indexOf('lead=lead-') !== -1, 'the redirect carries the lead id');
    ok(redirects[0].preBuilt === true, 'redirectTo is called with preBuilt=true (lead id already appended by hand)');
  }).catch((e) => { console.error('scenario10 error:', e); fail++; });
})();

// ═══ Scenario 11: professional tap -> e-prof-entry offers arm C's FULL
// five-industry picker, unrestricted (unlike arm D's own two-industry tap) ═══
(function scenario11() {
  const { routerERoot, bridge, RouterVariantE } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return settle().then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // Professional
    return settle();
  }).then(() => {
    const opts = findOptionButtons(routerERoot);
    ok(opts.length === 5, 'e-prof-entry offers all 5 industries (arm C\'s own PARTNER_INDUSTRY_ORDER), unlike arm D\'s own 2-option tap');
    ok(opts[0].textContent.indexOf('Real Estate Agent') !== -1, 'option 1 is Real Estate Agent (via AgentTypes.CHOOSER_LABELS)');
  }).catch((e) => { console.error('scenario11 error:', e); fail++; });
})();

// ═══ Scenario 12: realtor track end to end -- 4 questions, close
// paragraphs (verbatim), contact capture, redirect to partner-re.html ═══
(function scenario12() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, rpcCalls, redirects } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return settle().then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // Professional -> e-prof-entry
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // Real Estate Agent -> e-realtor-1
    return settle();
  }).then(() => {
    for (let i = 0; i < 4; i++) {
      const opts = findOptionButtons(routerERoot);
      opts[0].dispatchClick();
    }
    return settle();
  }).then(() => {
    const ps = flatten(routerERoot).filter((c) => c.tagName === 'P');
    ok(ps.some((p) => p.textContent.indexOf('It sounds like you might be a great fit for our realtor referral program') !== -1),
      'e-realtor-close renders arm C\'s realtorClose paragraphs verbatim');
    findContinueButton(routerERoot).dispatchClick(); // -> e-realtor-contact
    return settle();
  }).then(() => {
    const nameInput = flatten(routerERoot).find((c) => c.id === 'eGenName');
    const emailInput = flatten(routerERoot).find((c) => c.id === 'eGenEmail');
    nameInput.value = 'Pat Realtor';
    emailInput.value = 'pat@realty.example.com';
    findContinueButton(routerERoot).dispatchClick();
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1 && insertCalls[0].name === 'Pat Realtor', 'realtor contact screen inserts a fresh lead');
    const roleCall = rpcCalls.find((c) => c.name === 'set_lead_role');
    ok(!!roleCall && roleCall.args.p_role === 'referral_partner' && roleCall.args.p_partner_industry === 're_agent',
      'set_lead_role is called with referral_partner / re_agent');
    ok(redirects.length === 1 && redirects[0].dest.indexOf('partner-re.html') !== -1, 'redirects to partner-re.html');
  }).catch((e) => { console.error('scenario12 error:', e); fail++; });
})();

// ═══ Scenario 13: home_inspector/adjuster/other fall straight through to
// their destination page, no lead, matching arm C's own c-prof-entry ═══
(function scenario13() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, redirects } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return settle().then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // Professional
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[2].dispatchClick(); // Home Inspector
    return settle();
  }).then(() => {
    ok(insertCalls.length === 0, 'home_inspector never creates a lead -- matches arm C\'s own c-prof-entry fallback');
    ok(redirects.length === 1 && redirects[0].dest.indexOf('partner-inspectors.html') !== -1, 'redirects straight to partner-inspectors.html');
    ok(redirects[0].preBuilt === true, 'preBuilt=true -- attribution only, no lead id');
  }).catch((e) => { console.error('scenario13 error:', e); fail++; });
})();

// ═══ Scenario 14: contractor tap -> e-contractor-1..4 -> e-contractor-5
// (static text) -> contact -> redirect to contractor-join.html ═══
(function scenario14() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, rpcCalls, redirects } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return settle().then(() => {
    findOptionButtons(routerERoot)[2].dispatchClick(); // Contractor
    return settle();
  }).then(() => {
    for (let i = 0; i < 4; i++) {
      findOptionButtons(routerERoot)[0].dispatchClick();
    }
    return settle();
  }).then(() => {
    const p = flatten(routerERoot).find((c) => c.tagName === 'P');
    ok(!!p && p.textContent.indexOf('Our jobs arrive pre-scoped') !== -1, 'e-contractor-5 renders arm C\'s contractorQ5Text verbatim');
    findContinueButton(routerERoot).dispatchClick(); // -> e-contractor-contact
    return settle();
  }).then(() => {
    const nameInput = flatten(routerERoot).find((c) => c.id === 'eGenName');
    const emailInput = flatten(routerERoot).find((c) => c.id === 'eGenEmail');
    nameInput.value = 'Cam Contractor';
    emailInput.value = 'cam@contractor.example.com';
    findContinueButton(routerERoot).dispatchClick();
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'contractor contact screen inserts a fresh lead');
    const roleCall = rpcCalls.find((c) => c.name === 'set_lead_role');
    ok(!!roleCall && roleCall.args.p_role === 'contractor', 'set_lead_role is called with p_role="contractor"');
    ok(redirects.length === 1 && redirects[0].dest.indexOf('contractor-join.html') !== -1, 'redirects to contractor-join.html');
  }).catch((e) => { console.error('scenario14 error:', e); fail++; });
})();

// ═══ Scenario 15: double-tap guard on the generic contact screen
// (realtor/insurance/contractor share renderGenericContact) ═══
(function scenario15() {
  const { routerERoot, bridge, RouterVariantE, insertCalls } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return settle().then(() => {
    findOptionButtons(routerERoot)[2].dispatchClick(); // Contractor
    return settle();
  }).then(() => {
    for (let i = 0; i < 4; i++) { findOptionButtons(routerERoot)[0].dispatchClick(); }
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // -> e-contractor-contact
    return settle();
  }).then(() => {
    flatten(routerERoot).find((c) => c.id === 'eGenName').value = 'Cam Contractor';
    flatten(routerERoot).find((c) => c.id === 'eGenEmail').value = 'cam@contractor.example.com';
    const btn = findContinueButton(routerERoot);
    btn.dispatchClick();
    btn.dispatchClick(); // second tap before the first insert resolves
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'a rapid double-tap on the contractor contact screen produces exactly ONE leads insert');
  }).catch((e) => { console.error('scenario15 error:', e); fail++; });
})();

setTimeout(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}, 500);
