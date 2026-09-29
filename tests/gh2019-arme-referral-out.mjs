/**
 * gh-2019 (D-324) -- arm E disqualifier referral-out accept path.
 *
 * Same harness as tests/gh2076-variant-e.mjs (the DOM shim and buildScenario
 * below are copied from it, with the insertFreshLead stub widened to record
 * its 5th argument, the variant override): drives the ACTUAL
 * js/router-variant-e.js and js/router-discovery.js in a Node `vm` context
 * with a stubbed bridge. No real database write and no email is ever made.
 *
 * Asserts: each of the four arm-E disqualifier screens (e-dq-p6, e-dq-p8,
 * e-dq-p10, e-dq-p12) renders the accept path with Ben's four strings
 * verbatim (#2019 comment 5857659103); an empty or invalid address shows
 * "Please enter your email address." and writes nothing; a valid address
 * inserts ONE leads row marked variant='e-referral-out' carrying the name
 * from e-p5-5, then set_lead_role; and the confirmation replaces the form.
 *
 * Run: node tests/gh2019-arme-referral-out.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// GH2019_NEGATIVE_CONTROL_ROOT points this suite at a checkout of `main` (before
// this change) to prove the assertions below FAIL there.
const repoRoot = process.env.GH2019_NEGATIVE_CONTROL_ROOT || path.join(__dirname, '..');
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
    insertFreshLead: (name, email, phone, isSynthetic, variantOverride) => {
      insertCalls.push({ name, email, phone, isSynthetic: !!isSynthetic, variantOverride });
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
function settle() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => Promise.resolve());
}
function byId(root, id) { return flatten(root).find((c) => c.id === id); }
function theForm(root) { return flatten(root).find((c) => c.tagName === 'FORM'); }

// Ben's four strings, #2019 comment 5857659103, verbatim.
const S_LABEL = 'Your email';
const S_BUTTON = 'Send my request';
const S_CONFIRM = 'Thanks — we\'ve received your request. We\'ll email the contact information to you.';
const S_ERROR = 'Please enter your email address.';

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
// Drives to e-dq-p6 (name already given at e-p5-5 as "Jane Smith").
function driveToDqP6(routerERoot) {
  return driveToP5(routerERoot).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick();
    findContinueButton(routerERoot).dispatchClick(); // -> e-p5-5
    return settle();
  }).then(() => {
    fillAndSubmit(routerERoot, 'eName', 'Jane Smith'); // -> e-p6
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // a disqualifying answer
    findContinueButton(routerERoot).dispatchClick();
    return settle();
  });
}
// Continues past e-dq-p6 through e-p7 and e-p7-5 (real email), landing on e-p8.
function driveP6ContinueToP8(routerERoot) {
  return Promise.resolve().then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // dq opt1 -> e-p7
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // e-p7 -> e-p7-5
    return settle();
  }).then(() => {
    fillAndSubmit(routerERoot, 'eEmail', 'jane@example.com'); // -> e-p8
    return settle();
  });
}

function assertAcceptPath(routerERoot, label) {
  const lab = flatten(routerERoot).find((c) => c.tagName === 'LABEL');
  ok(!!lab && lab.textContent === S_LABEL, label + ': field label is exactly "Your email"');
  const inp = byId(routerERoot, 'rdReferralEmail');
  ok(!!inp && inp.tagName === 'INPUT' && inp.type === 'email', label + ': renders one email input');
  const btn = byId(routerERoot, 'rdReferralSubmit');
  ok(!!btn && btn.textContent === S_BUTTON, label + ': button is exactly "Send my request"');
  const err = byId(routerERoot, 'rdReferralEmailError');
  ok(!!err && err.textContent === '', label + ': no error shown before a submit attempt');
  const done = byId(routerERoot, 'rdReferralConfirmation');
  ok(!!done && done.hidden === true && done.textContent === S_CONFIRM, label + ': confirmation is exactly the approved sentence and starts hidden');
  ok(findOptionButtons(routerERoot).length === 1, label + ': the existing option-1 row is still there, unchanged');
}

// Scenario 1: all four disqualifier screens render the accept path.
(function scenario1() {
  const { routerERoot, bridge, RouterVariantE, insertCalls } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToDqP6(routerERoot).then(() => {
    assertAcceptPath(routerERoot, 'e-dq-p6');
    return driveP6ContinueToP8(routerERoot);
  }).then(() => {
    findOptionButtons(routerERoot)[2].dispatchClick(); // e-p8 disqualifying option
    return settle();
  }).then(() => {
    assertAcceptPath(routerERoot, 'e-dq-p8');
    findOptionButtons(routerERoot)[0].dispatchClick(); // -> e-p9
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // -> e-p10
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[5].dispatchClick();
    findContinueButton(routerERoot).dispatchClick(); // -> e-dq-p10
    return settle();
  }).then(() => {
    assertAcceptPath(routerERoot, 'e-dq-p10');
    findOptionButtons(routerERoot)[0].dispatchClick(); // -> e-p11
    return settle();
  }).then(() => {
    findContinueButton(routerERoot).dispatchClick(); // -> e-p12
    return settle();
  }).then(() => {
    findOptionButtons(routerERoot)[0].dispatchClick(); // -> e-dq-p12
    return settle();
  }).then(() => {
    assertAcceptPath(routerERoot, 'e-dq-p12');
    ok(insertCalls.filter((c) => c.variantOverride === 'e-referral-out').length === 0,
      'merely viewing the four screens writes no referral row');
  }).catch((e) => { console.error('scenario1 error:', e); fail++; });
})();

// Scenario 2: empty and invalid addresses show the error and write nothing.
(function scenario2() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, rpcCalls } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToDqP6(routerERoot).then(() => {
    const form = theForm(routerERoot);
    const inp = byId(routerERoot, 'rdReferralEmail');
    inp.value = '';
    form.dispatchEvent('submit');
    return settle().then(() => {
      ok(byId(routerERoot, 'rdReferralEmailError').textContent === S_ERROR, 'empty address shows exactly "Please enter your email address."');
      inp.value = '   ';
      form.dispatchEvent('submit');
      return settle();
    }).then(() => {
      ok(byId(routerERoot, 'rdReferralEmailError').textContent === S_ERROR, 'whitespace-only address shows the same error');
      inp.value = 'not-an-email';
      form.dispatchEvent('submit');
      return settle();
    }).then(() => {
      ok(byId(routerERoot, 'rdReferralEmailError').textContent === S_ERROR, 'an invalid address shows the same error');
      ok(insertCalls.length === 0 && rpcCalls.length === 0, 'an empty or invalid address inserts nothing and calls no RPC');
      ok(byId(routerERoot, 'rdReferralConfirmation').hidden === true && form.hidden !== true, 'no confirmation is shown on an error');
    });
  }).catch((e) => { console.error('scenario2 error:', e); fail++; });
})();

// Scenario 3: a valid address is captured -- one marked row carrying the
// e-p5-5 name, set_lead_role, an event, the confirmation, no Lead event.
(function scenario3() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, rpcCalls, trackedEvents } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToDqP6(routerERoot).then(() => {
    const form = theForm(routerERoot);
    byId(routerERoot, 'rdReferralEmail').value = '  buyer@example.com ';
    form.dispatchEvent('submit');
    form.dispatchEvent('submit'); // a double submit in the same tick must not double-insert
    return settle().then(() => {
      ok(insertCalls.length === 1, 'submit calls the capture: exactly one leads insert, even on a double submit');
      const c = insertCalls[0];
      ok(c.name === 'Jane Smith' && c.email === 'buyer@example.com' && c.phone === null,
        'the row carries the name from e-p5-5 and the trimmed email, no phone');
      ok(c.variantOverride === 'e-referral-out', 'the row is marked variant "e-referral-out"');
      const role = rpcCalls.filter((r) => r.name === 'set_lead_role');
      ok(role.length === 1 && role[0].args.p_role === 'homeowner' && role[0].args.p_lead_id === 'lead-1',
        'set_lead_role(homeowner) follows the insert, so the existing router-lead admin alert fires');
      const ev = trackedEvents.filter((e) => e.name === 'router_referral_out_requested');
      ok(ev.length === 1 && ev[0].extra.step === 'e-p6', 'router_referral_out_requested fires once, tagged with the source screen e-p6');
      ok(!trackedEvents.some((e) => e.name === 'router_contact_submitted'), 'no router_contact_submitted (a disqualified visitor is not a converted lead)');
      ok(byId(routerERoot, 'rdReferralConfirmation').hidden === false && form.hidden === true,
        'the approved confirmation replaces the form');
      ok(byId(routerERoot, 'rdReferralConfirmation').textContent === S_CONFIRM, 'the confirmation text is exact');
      ok(findOptionButtons(routerERoot).length === 1, 'option 1 (continue) is still available after the request');
    });
  }).catch((e) => { console.error('scenario3 error:', e); fail++; });
})();

// Scenario 4: the request row is never mistaken for the qualified lead --
// continuing to e-p7-5 still makes a FRESH, unmarked insert (no PATCH of the
// referral row); a repeat request from a later dq screen does not re-insert.
(function scenario4() {
  const { routerERoot, bridge, RouterVariantE, insertCalls, rpcCalls } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return driveToDqP6(routerERoot).then(() => {
    byId(routerERoot, 'rdReferralEmail').value = 'buyer@example.com';
    theForm(routerERoot).dispatchEvent('submit');
    return settle();
  }).then(() => driveP6ContinueToP8(routerERoot)).then(() => {
    ok(insertCalls.length === 2 && insertCalls[1].variantOverride === undefined && insertCalls[1].email === 'jane@example.com',
      'e-p7-5 after a referral request makes its own fresh, unmarked insert');
    ok(!rpcCalls.some((r) => r.name === 'update_lead_contact'), 'e-p7-5 does not PATCH the referral row');
    findOptionButtons(routerERoot)[2].dispatchClick(); // e-p8 dq
    return settle();
  }).then(() => {
    byId(routerERoot, 'rdReferralEmail').value = 'BUYER@example.com';
    theForm(routerERoot).dispatchEvent('submit');
    return settle();
  }).then(() => {
    ok(insertCalls.filter((c) => c.variantOverride === 'e-referral-out').length === 1,
      'the same address requested again (any case) in one session does not insert a second row');
    ok(byId(routerERoot, 'rdReferralConfirmation').hidden === false, 'and still shows the confirmation');
  }).catch((e) => { console.error('scenario4 error:', e); fail++; });
})();

// Scenario 5: a failed save keeps the form, re-enables the button, and
// routes through the existing generic error -- never a false confirmation.
(function scenario5() {
  const { routerERoot, bridge, RouterVariantE } = buildScenario();
  const errors = [];
  bridge.insertFreshLead = () => Promise.reject(new Error('boom'));
  bridge.showError = (m) => { errors.push(m); };
  const origError = console.error;
  RouterVariantE.init(bridge, routerERoot);
  return driveToDqP6(routerERoot).then(() => {
    console.error = () => {};
    byId(routerERoot, 'rdReferralEmail').value = 'buyer@example.com';
    theForm(routerERoot).dispatchEvent('submit');
    return settle();
  }).then(() => {
    console.error = origError;
    ok(errors.length === 1, 'a failed insert calls the existing bridge.showError');
    ok(byId(routerERoot, 'rdReferralConfirmation').hidden === true, 'no confirmation after a failed save');
    ok(byId(routerERoot, 'rdReferralSubmit').disabled === false, 'the button is re-enabled so the visitor can retry');
  }).catch((e) => { console.error = origError; console.error('scenario5 error:', e); fail++; });
})();

// Scenario 6: a set_lead_role failure does not present as a failed request.
(function scenario6() {
  const { routerERoot, bridge, RouterVariantE } = buildScenario({
    rpcResponder: () => Promise.reject(new Error('role write failed'))
  });
  const origError = console.error;
  RouterVariantE.init(bridge, routerERoot);
  return driveToDqP6(routerERoot).then(() => {
    console.error = () => {};
    byId(routerERoot, 'rdReferralEmail').value = 'buyer@example.com';
    theForm(routerERoot).dispatchEvent('submit');
    return settle();
  }).then(() => {
    console.error = origError;
    ok(byId(routerERoot, 'rdReferralConfirmation').hidden === false, 'the row is saved, so the confirmation shows even if the role write failed');
  }).catch((e) => { console.error = origError; console.error('scenario6 error:', e); fail++; });
})();

// Scenario 7: static guards -- exact strings in the module, no delivery
// time, no D-104 words, arm C's renderer unchanged without onReferral.
(function scenario7() {
  const { routerERoot, bridge, RouterVariantE, ctx } = buildScenario();
  RouterVariantE.init(bridge, routerERoot);
  return settle().then(() => {
    const COPY = ctx.window.RouterDiscovery.COPY;
    ok(COPY.referralEmailLabel === S_LABEL && COPY.referralButton === S_BUTTON &&
       COPY.referralConfirmation === S_CONFIRM && COPY.referralEmailError === S_ERROR,
      'COPY carries Ben\'s four strings verbatim (#2019 comment 5857659103)');
    const all = [COPY.referralEmailLabel, COPY.referralButton, COPY.referralConfirmation, COPY.referralEmailError].join(' ');
    ok(!/\b(minutes?|hours?|days?|shortly|soon|today|tomorrow|within|immediately|instantly)\b/i.test(all), 'no delivery time anywhere in the four strings');
    ok(!/\b(vetted|approved|endorsed|certified|screened|verified|recommend\w*)\b/i.test(all), 'no D-104 words in the four strings');
    const root2 = ctx.document.createElement('div');
    ctx.window.RouterDiscovery.renderDisqualifier(root2, { text: 't', opt1: 'o', onContinue() {} });
    ok(!flatten(root2).some((c) => c.tagName === 'FORM' || c.tagName === 'INPUT'),
      'renderDisqualifier without onReferral (arm C) renders no accept path -- unchanged');
  }).catch((e) => { console.error('scenario7 error:', e); fail++; });
})();

setTimeout(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}, 1500);
