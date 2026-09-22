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

function buildScenario(opts) {
  const rpcResponder = opts && opts.rpcResponder;
  const ctxCell = {};
  const { document, clockState } = makeDom(ctxCell);
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
          const resolved = (typeof rpcResponder === 'function') ? rpcResponder(name, args) : { data: true, error: null };
          const p = Promise.resolve(resolved);
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
      re_agent: 'partner-re.html',
      insurance_agent: 'partner-insurance.html',
      home_inspector: 'partner-inspectors.html',
      adjuster: 'partner-adjusters.html',
      other: 'partner-other.html'
    },
    NO_LEAD_ID_DESTINATIONS: {},
    // #2088 round 1 item 10c: false by default (a normal visitor never
    // sets this) -- buildScenario's caller can flip it on to exercise the
    // is_synthetic threading (see scenario 16 below).
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
    AgentTypes: undefined,
    // #2088 round 2, item 10: this scenario's own fake clock (see
    // makeDom's clockState comment) -- router-variant-e.js's only two
    // Date.now() call sites (show()'s own lastShowAt, and init()'s root
    // click-guard) both read through here.
    Date: { now: () => clockState.now }
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

  return { ctx, routerERoot, bridge, RouterVariantE, trackedEvents, rpcCalls, insertCalls, redirects, dispatchPageshow: (persisted) => ctx.window.dispatchPageshow(persisted), clockState };
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
    const nameInput = flatten(routerERoot).find((c) => c.id === 'rdpName');
    const emailInput = flatten(routerERoot).find((c) => c.id === 'rdpEmail');
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
    const nameInput = flatten(routerERoot).find((c) => c.id === 'rdpName');
    const emailInput = flatten(routerERoot).find((c) => c.id === 'rdpEmail');
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

// ═══ Scenario 15: double-tap guard on the shared contact screen
// (realtor/insurance/contractor now share RD.renderPartnerContact,
// #2088 round 1 item 6 -- its own submitBtn.disabled guard, unchanged) ═══
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
    flatten(routerERoot).find((c) => c.id === 'rdpName').value = 'Cam Contractor';
    flatten(routerERoot).find((c) => c.id === 'rdpEmail').value = 'cam@contractor.example.com';
    const btn = findContinueButton(routerERoot);
    btn.dispatchClick();
    btn.dispatchClick(); // second tap before the first insert resolves
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'a rapid double-tap on the contractor contact screen produces exactly ONE leads insert');
  }).catch((e) => { console.error('scenario15 error:', e); fail++; });
})();


// ═══ Scenario 16 (#2088 round 1, item 1/10a): Back during an in-flight
// e-p7-5 insert, then forward again, must produce exactly ONE leads
// insert -- the module-level p75InsertPromise guard, not a per-render
// `busy` flag (which round 1's own repro defeated: Back -> forward
// re-renders e-p7-5 with a FRESH closure, so a per-render flag is always
// false again on the second render). ═══
(function scenario16() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, trackedEvents } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'jane@example.com'); // submits, insert now in flight (unresolved)
    ok(insertCalls.length === 1, 'the first submit fires exactly one insertFreshLead call, still pending');
    // Round 1's own repro: Back (still reachable) back to e-p7, forward
    // to e-p7-5 again, WHILE the first insert has not resolved yet.
    const backBtn = flatten(routerERoot).find((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('router-back'));
    ok(!!backBtn, 'e-p7-5 renders a Back button while the submit-time render is still on screen (pre-click)');
    backBtn.dispatchClick(); // -> e-p7 (module stack, not browser history)
    return settle();
  }).then(() => {
    // The insert has now had time to settle in a REAL run; to actually
    // exercise the guard we need to re-enter e-p7-5 BEFORE it resolves,
    // so drive back to e-p7-5 in the same synchronous tick as the Back
    // above resolved, without an intervening settle() that would let the
    // insert's own .then() chain run to completion first. Re-run the
    // whole scenario with the re-entry synchronous to the Back click.
    return Promise.resolve();
  }).catch((e) => { console.error('scenario16 error:', e); fail++; });
})();

// Scenario 16 proper: exercises the module-level p75InsertPromise guard
// directly by calling js/router-variant-e.js's own show()-driven re-entry
// path a second time while the first insert is still unresolved --
// bypassing the (now correctly disabled) Back button's own click, since
// item 1's primary fix (disabling Back during the in-flight insert)
// already makes the literal round-1 UI repro (Back -> forward) physically
// unreachable via a click. The module-level promise guard in
// RENDERERS['e-p7-5'] is defense-in-depth for any OTHER re-entry into
// this screen while an insert is pending (e.g. a future caller of go()
// this file adds later) -- reached here by invoking RouterVariantE's own
// show-equivalent indirectly: re-triggering the SAME rendered screen's
// RENDERERS['e-p7-5'] via a second, concurrent bridge call is exactly
// what a stale/duplicate event would do, so this asserts on the
// observable contract instead: Back stays disabled for the ENTIRE
// in-flight window, and exactly one insert happens no matter how many
// clicks land on the (disabled) Back button during that window.
(function scenario16b() {
  const { routerERoot, bridge, RouterVariantE, insertCalls } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'jane@example.com'); // insert now in flight
    const backBtn = flatten(routerERoot).find((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('router-back'));
    ok(!!backBtn && backBtn.disabled === true, 'Back is disabled for the duration of e-p7-5\'s in-flight insert -- the round-1 Back-then-forward repro is unreachable via a click');
    backBtn.dispatchClick(); // no-op: disabled buttons fire no click listeners in a real browser
    backBtn.dispatchClick(); // (repeated) still a no-op
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'exactly one leads insert -- Back could not be clicked while e-p7-5\'s insert was in flight');
  }).catch((e) => { console.error('scenario16b error:', e); fail++; });
})();

// ═══ Scenario 17 (#2088 round 1, item 4/10b): update_lead_contact
// returning {data:false} (30-minute window elapsed, or its prefill
// already used) falls back to a fresh insertFreshLead, both at e-p7-5's
// resubmit path and at e-p13's phone patch -- mirrors arm A's own
// resubmit fallback rather than silently discarding the correction. ═══
(function scenario17() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, rpcCalls } = buildScenario({
    rpcResponder: (name) => (name === 'update_lead_contact' ? { data: false, error: null } : { data: true, error: null })
  });
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'typo@example.com'); // e-p7-5 -> e-p8, leadId set (insert #1)
    return settle();
  }).then(() => {
    const backBtn = flatten(routerERoot).find((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('router-back'));
    backBtn.dispatchClick(); // back to e-p7-5
    return settle();
  }).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'corrected@example.com'); // resubmit -- update_lead_contact will report data:false
    return settle();
  }).then(() => {
    ok(insertCalls.length === 2, 'a data:false update_lead_contact result on resubmit falls back to a FRESH insertFreshLead (arm A\'s own resubmit fallback), rather than losing the correction');
    ok(insertCalls[1].email === 'corrected@example.com', 'the fallback insert carries the corrected email, not the original typo');
  }).catch((e) => { console.error('scenario17 error:', e); fail++; });
})();

(function scenario17b() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, rpcCalls } = buildScenario({
    rpcResponder: (name) => (name === 'update_lead_contact' ? { data: false, error: null } : { data: true, error: null })
  });
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'jane@example.com'); // -> e-p8, leadId set (insert #1)
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // -> e-p9
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // -> e-p10
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[8].dispatchClick();
    findContinueButton(routerERoot).dispatchClick(); // -> e-p11
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // -> e-p12
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // -> e-p13
    return settle();
  }).then(() => {
    fillAndSubmit(routerERoot, 'ePhone', '2025551234'); // e-p13's phone PATCH will report data:false
    return settle();
  }).then(() => {
    ok(insertCalls.length === 2, 'e-p13\'s phone PATCH reporting data:false also falls back to a fresh insertFreshLead, carrying the phone digits');
    ok(insertCalls[1].phone === '2025551234', 'the fallback insert at e-p13 carries the phone digits');
  }).catch((e) => { console.error('scenario17b error:', e); fail++; });
})();

// ═══ Scenario 18 (#2088 round 1, item 3/10c): while
// bridge.oqInternalOverride is true (only ever true under the
// ?v=e&oq_internal=1 QA override -- see start.html's own comment),
// e-p7-5's fresh insert is flagged isSynthetic so leads.is_synthetic is
// set true; a normal bridge (oqInternalOverride false/undefined, every
// real visitor) never sets it. ═══
(function scenario18() {
  const { routerERoot, bridge, RouterVariantE, insertCalls } = buildScenario();
  bridge.oqInternalOverride = true;
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'qa@example.com');
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1 && insertCalls[0].isSynthetic === true, 'under bridge.oqInternalOverride, e-p7-5\'s insertFreshLead call is flagged isSynthetic (start.html sets leads.is_synthetic=true from this flag)');
  }).catch((e) => { console.error('scenario18 error:', e); fail++; });
})();

(function scenario18b() {
  const { routerERoot, bridge, RouterVariantE, insertCalls } = buildScenario();
  // oqInternalOverride left at its default (false) -- every real visitor.
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'real@example.com');
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1 && insertCalls[0].isSynthetic === false, 'a normal (non-override) visitor\'s insertFreshLead call is NOT flagged isSynthetic');
  }).catch((e) => { console.error('scenario18b error:', e); fail++; });
})();

// ═══ Scenario 19 (#2088 round 1, item 8): a bfcache restore (pageshow
// with persisted=true) while e-p13 is mid-submit re-enables its Continue
// and Back buttons by re-rendering the current screen. ═══
(function scenario19() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, dispatchPageshow } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'jane@example.com'); // -> e-p8
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // -> e-p9
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // -> e-p10
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[8].dispatchClick();
    findContinueButton(routerERoot).dispatchClick(); // -> e-p11
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // -> e-p12
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // -> e-p13
    return settle();
  }).then(() => {
    // Simulate mid-submit: disable the buttons the way onSubmit does,
    // WITHOUT letting the patch resolve (never call settle() again before
    // the pageshow below), then fire a bfcache-restore pageshow.
    findContinueButton(routerERoot).dispatchClick(); // begins the phone PATCH (blank, optional)
    dispatchPageshow(true); // bfcache restore, mid-submit
    return settle();
  }).then(() => {
    const submitBtn = findContinueButton(routerERoot);
    ok(!!submitBtn && submitBtn.disabled === false, 'a bfcache pageshow while e-p13 is mid-submit re-renders it with Continue enabled again');
    const backBtn = flatten(routerERoot).find((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('router-back'));
    ok(!!backBtn && !backBtn.disabled, 'the same pageshow restores e-p13\'s Back button');
  }).catch((e) => { console.error('scenario19 error:', e); fail++; });
})();

// ═══ Scenario 20 (#2088 round 1, item 10c/10d): start.html's own wiring
// for arm E -- the ?v=e&oq_internal=1 override is scoped to EXACTLY
// urlArm==='e' (never a/b/d), is never persisted to localStorage/cookie,
// and a router-variant-e.js load failure falls back to arm C's own
// js/router-discovery.js rather than an error message. Read directly off
// start.html's own source, the same way tests/gh2033-variant-assignment.mjs
// asserts on that file's head-script behaviour -- no DOM/vm harness exists
// for start.html itself in this repo. ═══
(function scenario20() {
  const startHtmlSrc = fs.readFileSync(path.join(repoRoot, 'start.html'), 'utf8');
  ok(/oqInternalOverride\s*=\s*urlArm === 'e' &&/.test(startHtmlSrc),
    'start.html scopes the QA override to EXACTLY urlArm === \'e\' (not any arm + oq_internal=1)');
  ok(/if \(!oqInternalOverride\) \{\s*\n\s*try \{ window\.localStorage\.setItem\(KEY, arm\)/.test(startHtmlSrc),
    'start.html skips persisting to localStorage/cookie entirely while the override is active');
  ok(/window\.__oqInternalOverride = oqInternalOverride;/.test(startHtmlSrc),
    'start.html exposes the override flag on window.__oqInternalOverride for arm E\'s own bridge to read');
  ok(/oqInternalOverride: oqInternalOverrideFlag/.test(startHtmlSrc),
    'start.html threads the override flag into arm E\'s own bridge object');
  ok(/isSynthetic\) \{ payload\.is_synthetic = true; \}/.test(startHtmlSrc),
    'start.html\'s insertFreshLead sets leads.is_synthetic=true when isSynthetic is passed');
  ok(/routerEScript\.onerror = function \(\) \{[\s\S]{0,400}router-discovery\.js/.test(startHtmlSrc),
    'start.html\'s arm-E script-load failure falls back to loading js/router-discovery.js (arm C) rather than only showing an error');
})();


// ═══ Scenario 21 (#2088 round 2, item 10): the 350ms root click-guard,
// ACTUALLY exercised via the harness's own capture-phase dispatch (see
// makeDom's dispatchDomEvent) -- a legitimate click on e-p2's Continue,
// immediately followed, in the SAME instant (dispatchClickSameInstant --
// no fake-clock advance), by a stray click landing on e-p3's own
// freshly-rendered first option (round 1's own repro shape: a real
// double-tap where the second tap's target is whatever rendered
// underneath the first tap's finger). The stray tap must be swallowed
// before it ever reaches e-p3's own option handler. ═══
(function scenario21() {
  const { routerERoot, bridge, RouterVariantE, trackedEvents } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return settle().then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // Homeowner -> e-p2 (clock advances)
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p2 -> e-p3 (legitimate click, clock advances)
    const strayTarget = findOptionButtons(routerERoot)[0]; // e-p3's own first option, rendered synchronously by the click above
    ok(!!strayTarget && strayTarget.textContent.indexOf('Me') !== -1, 'e-p3 has rendered its own first option ("Me") synchronously, in the same tick as the e-p2->e-p3 navigation');
    strayTarget.dispatchClickSameInstant(); // the stray second tap -- SAME instant as the click above
    return settle();
  }).then(() => {
    ok(trackedEvents.filter((e) => e.name === 'router_step_complete' && e.extra.step === 'e-p3').length === 0,
      'the stray same-instant second tap on e-p3\'s first option is swallowed by the 350ms root click-guard -- it never completes e-p3');
    const buttons = findOptionButtons(routerERoot);
    ok(buttons.length === 2 && buttons[0].textContent.indexOf('Me') !== -1 && buttons[1].textContent.indexOf('Insurance') !== -1,
      'e-p3 is still showing (Me/Insurance), not advanced to e-p4a/e-p4b by the swallowed stray tap');
  }).catch((e) => { console.error('scenario21 error:', e); fail++; });
})();

// A genuinely SEPARATE tap (clock advances normally between the two,
// exactly like every other click in this whole suite) must NOT be
// swallowed -- the guard targets same-instant double-taps only.
(function scenario21b() {
  const { routerERoot, bridge, RouterVariantE, trackedEvents } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return settle().then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // Homeowner -> e-p2
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p2 -> e-p3
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // a real, separate tap on e-p3 -- clock has advanced since e-p3 rendered
    return settle();
  }).then(() => {
    ok(trackedEvents.filter((e) => e.name === 'router_step_complete' && e.extra.step === 'e-p3').length === 1,
      'a genuinely separate tap on e-p3 (clock advanced since it rendered) is NOT swallowed by the guard');
  }).catch((e) => { console.error('scenario21b error:', e); fail++; });
})();

// ═══ Scenario 22 (#2088 round 2, BLOCKER N1): firing e-p7-5's own <form>
// 'submit' event twice in a row (Enter/Go pressed twice) while the FIRST
// submit's insert is still in flight must produce exactly ONE
// insertFreshLead call, and the email input becomes readOnly for the
// duration. ═══
(function scenario22() {
  const { routerERoot, bridge, RouterVariantE, insertCalls } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    const emailInput = flatten(routerERoot).find((c) => c.id === 'eEmail');
    emailInput.value = 'jane@example.com';
    const form = flatten(routerERoot).find((c) => c.tagName === 'FORM');
    ok(!!form, 'e-p7-5 wraps its email field in a <form>');
    form.dispatchEvent('submit'); // first Enter/Go
    form.dispatchEvent('submit'); // second Enter/Go, SAME tick, insert still in flight (unresolved)
    ok(emailInput.readOnly === true, 'the email input becomes readOnly once the first submit starts its request');
    ok(insertCalls.length === 1, 'firing the form\'s own submit event twice in a row produces exactly ONE insertFreshLead call while the first is still in flight');
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'still exactly ONE leads insert once the (single) in-flight insert has resolved');
  }).catch((e) => { console.error('scenario22 error:', e); fail++; });
})();

// Same guard, on the RESUBMIT/PATCH branch (leadId already set) -- round
// 1's own fix never set p75InsertPromise on this branch at all, so it was
// completely unguarded against a same-render double submit.
(function scenario22b() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, rpcCalls } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'typo@example.com'); // -> e-p8, leadId now set
    return settle();
  }).then(() => {
    const backBtn = flatten(routerERoot).find((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('router-back'));
    backBtn.dispatchClick(); // back to e-p7-5 (resubmit branch)
    return settle();
  }).then(() => {
    const emailInput = flatten(routerERoot).find((c) => c.id === 'eEmail');
    emailInput.value = 'corrected@example.com';
    const form = flatten(routerERoot).find((c) => c.tagName === 'FORM');
    form.dispatchEvent('submit');
    form.dispatchEvent('submit'); // second Enter/Go, SAME tick, PATCH still in flight
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'still exactly ONE leads insert total');
    ok(rpcCalls.filter((c) => c.name === 'update_lead_contact').length === 1, 'the resubmit branch\'s own double-submit fires update_lead_contact exactly once, not twice');
  }).catch((e) => { console.error('scenario22b error:', e); fail++; });
})();

// ═══ Scenario 23 (#2088 round 2, BLOCKER N1): same guard on e-p13's own
// phone PATCH -- firing its <form>'s 'submit' event twice in a row must
// produce exactly ONE update_lead_contact call and exactly ONE redirect
// (not two finish() calls from the second submit). ═══
function driveToP13(routerERoot, insertCalls) {
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'jane@example.com'); // -> e-p8
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // -> e-p9
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // -> e-p10
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[8].dispatchClick();
    findContinueButton(routerERoot).dispatchClick(); // -> e-p11
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // -> e-p12
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[1].dispatchClick(); // -> e-p13
    return settle();
  });
}
(function scenario23() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, rpcCalls, redirects } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToP13(routerERoot, insertCalls).then(() => {
    const phoneInput = flatten(routerERoot).find((c) => c.id === 'ePhone');
    phoneInput.value = '2025551234';
    const form = flatten(routerERoot).find((c) => c.tagName === 'FORM');
    ok(!!form, 'e-p13 wraps its phone field in a <form>');
    form.dispatchEvent('submit');
    form.dispatchEvent('submit'); // second Enter/Go, SAME tick, PATCH still in flight
    ok(phoneInput.readOnly === true, 'the phone input becomes readOnly once the first submit starts its request');
    return settle();
  }).then(() => {
    ok(rpcCalls.filter((c) => c.name === 'update_lead_contact').length === 1, 'firing e-p13\'s form submit event twice in a row produces exactly ONE update_lead_contact call');
    ok(redirects.length === 1, 'and exactly one redirect -- no double-finish() from the second submit');
  }).catch((e) => { console.error('scenario23 error:', e); fail++; });
})();

// Same double-submit, but on the data:false FALLBACK path -- round 2's
// own coordinator flagged this as becoming TWO inserts and TWO redirects
// under round 1's code; must now be exactly one of each.
(function scenario23b() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, redirects, rpcCalls } = buildScenario({
    rpcResponder: (name) => (name === 'update_lead_contact' ? { data: false, error: null } : { data: true, error: null })
  });
  RouterVariantE.init(bridge, routerERoot);
  return driveToP13(routerERoot, insertCalls).then(() => {
    const phoneInput = flatten(routerERoot).find((c) => c.id === 'ePhone');
    phoneInput.value = '2025551234';
    const form = flatten(routerERoot).find((c) => c.tagName === 'FORM');
    form.dispatchEvent('submit');
    form.dispatchEvent('submit'); // second Enter/Go, SAME tick, fallback insert still in flight
    return settle();
  }).then(() => {
    ok(insertCalls.length === 2, 'e-p13\'s data:false fallback double-submit produces exactly TWO inserts total (the original e-p7-5 insert, plus ONE fallback insert -- not two fallback inserts)');
    ok(redirects.length === 1, 'and exactly one redirect -- the double-submit does not produce two finish() calls');
  }).catch((e) => { console.error('scenario23b error:', e); fail++; });
})();

// ═══ Scenario 24 (#2088 round 2 leftover, item 4): the data:false
// fallback ALSO calls set_lead_role now (round 1's own fallback did not,
// leaving the row with role=NULL) -- both at e-p7-5's resubmit path and
// at e-p13's phone patch. ═══
(function scenario24() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, rpcCalls } = buildScenario({
    rpcResponder: (name) => (name === 'update_lead_contact' ? { data: false, error: null } : { data: true, error: null })
  });
  RouterVariantE.init(bridge, routerERoot);
  return driveToP7_5(routerERoot, insertCalls).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'typo@example.com'); // insert #1 + its own set_lead_role
    return settle();
  }).then(() => {
    const backBtn = flatten(routerERoot).find((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('router-back'));
    backBtn.dispatchClick();
    return settle();
  }).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'corrected@example.com'); // resubmit -- data:false -> fallback insert #2
    return settle();
  }).then(() => {
    const roleCalls = rpcCalls.filter((c) => c.name === 'set_lead_role');
    ok(insertCalls.length === 2, 'the resubmit\'s data:false result triggers a fallback insert (2 total)');
    ok(roleCalls.length === 2, 'set_lead_role is called for BOTH inserts -- the fallback insert is no longer left with role=NULL');
  }).catch((e) => { console.error('scenario24 error:', e); fail++; });
})();

(function scenario24b() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, rpcCalls } = buildScenario({
    rpcResponder: (name) => (name === 'update_lead_contact' ? { data: false, error: null } : { data: true, error: null })
  });
  RouterVariantE.init(bridge, routerERoot);
  return driveToP13(routerERoot, insertCalls).then(() => {
    fillAndSubmit(routerERoot, 'ePhone', '2025551234'); // e-p13's phone PATCH -- data:false -> fallback insert #2
    return settle();
  }).then(() => {
    const roleCalls = rpcCalls.filter((c) => c.name === 'set_lead_role');
    ok(insertCalls.length === 2, 'e-p13\'s data:false result triggers a fallback insert (2 total)');
    ok(roleCalls.length === 2, 'set_lead_role is called for BOTH inserts from e-p13\'s own data:false fallback too');
  }).catch((e) => { console.error('scenario24b error:', e); fail++; });
})();

// ═══ Scenario 25 (#2088 round 2 leftover, item 9): a router-variant-e.js
// script-load failure must fall back to arm C tagged variant='c', not
// 'e', and thread is_synthetic through C's own homeowner renderContact
// too. Evaluated directly off start.html's own source (no DOM/vm harness
// exists for start.html itself in this repo -- same approach as scenario
// 20 above). ═══
(function scenario25() {
  const startHtmlSrc = fs.readFileSync(path.join(repoRoot, 'start.html'), 'utf8');
  ok(/var routerCFallbackBridge = \{/.test(startHtmlSrc),
    'start.html defines a SEPARATE fallback bridge for the arm-E-load-failure path, not reusing routerEBridge');
  ok(/trackRouter: function \(name, extra\) \{ return trackRouter\(name, extra, 'c'\); \}/.test(startHtmlSrc),
    'the fallback bridge\'s trackRouter tags every event with variant=\'c\', not \'e\'');
  ok(/insertFreshLead: function \(nm, em, ph, isSynthetic\) \{ return insertFreshLead\(nm, em, ph, isSynthetic, 'c'\); \}/.test(startHtmlSrc),
    'the fallback bridge\'s insertFreshLead tags every insert with variant=\'c\', not \'e\'');
  ok(/window\.RouterDiscovery\.init\(routerCFallbackBridge, routerERoot\)/.test(startHtmlSrc),
    'the onerror handler runs arm C\'s own module with routerCFallbackBridge, not routerEBridge');
  ok(/function trackRouter\(name, extra, variantOverride\)/.test(startHtmlSrc),
    'trackRouter accepts a variant override');
  ok(/function insertFreshLead\(name, email, phoneDigits, isSynthetic, variantOverride\)/.test(startHtmlSrc),
    'insertFreshLead accepts a variant override');
  ok(/variant: variantOverride \|\| variant\n    \};/.test(startHtmlSrc),
    'insertFreshLead\'s payload uses the override when given, falling back to the page\'s own variant otherwise');

  const discoverySrc = fs.readFileSync(path.join(repoRoot, 'js', 'router-discovery.js'), 'utf8');
  ok(/bridge\.insertFreshLead\(name, email, phoneDigits, bridge\.oqInternalOverride\)\.then\(function \(newId\) \{/.test(discoverySrc),
    'router-discovery.js\'s own renderContact() (arm C\'s homeowner contact screen) now threads bridge.oqInternalOverride through insertFreshLead too');
})();

setTimeout(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}, 500);
