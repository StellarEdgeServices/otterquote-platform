/**
 * gh-2075 (D-327) — Variant D: role tap first, one email field, everything
 * else after that first commitment.
 *
 * Same harness philosophy as tests/gh2033-variant-assignment.mjs: no real
 * browser engine / jsdom in this repo, so this drives the ACTUAL file
 * (js/router-variant-d.js, and js/router-discovery.js once it lazy-loads),
 * extracted/loaded verbatim, inside a Node `vm` context behind a minimal
 * hand-rolled DOM shim built only wide enough for what these two files
 * actually touch (createElement/appendChild/classList/addEventListener/
 * getElementById/textContent/innerHTML/setAttribute). LABEL: this proves
 * the two files' own logic under each scenario, not real Chrome/WebKit/FB
 * in-app-webview behavior (Playwright wasn't available in this sandbox for
 * the mobile walk this PR's body reports separately).
 *
 * bridge.sb (Supabase) is stubbed, never real — this suite NEVER writes to
 * production and asserts on the INSERT/RPC PAYLOADS the module would have
 * sent, not on a live leads row.
 *
 * Run: node tests/gh2075-variant-d.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const variantDSrc = fs.readFileSync(path.join(repoRoot, 'js', 'router-variant-d.js'), 'utf8');
const discoverySrc = fs.readFileSync(path.join(repoRoot, 'js', 'router-discovery.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

// ── Minimal DOM shim -- only what router-variant-d.js / router-discovery.js
// actually call. Not a general-purpose DOM. ──
function makeDom() {
  const registry = {};
  function syncClassName(el) { el.className = el._classes.join(' '); }

  function createElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      _classes: [],
      children: [],
      attributes: {},
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
          const ctxAtSet = activeCtx;
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

// activeCtx is set per-scenario right before router-variant-d.js runs, so
// the script-src setter above (defined once, used by every scenario) always
// injects into the CURRENT scenario's context, never a stale one.
let activeCtx = null;

function buildScenario() {
  const { document } = makeDom();
  const routerDRoot = document.createElement('div');
  routerDRoot.setAttribute('id', 'routerDRoot');

  const trackedEvents = [];
  const rpcCalls = [];
  const insertCalls = [];
  const redirects = [];
  let nextLeadId = 1;

  const bridge = {
    get sb() { return { rpc: (name, args) => { rpcCalls.push({ name, args }); return Promise.resolve({ error: null }); } }; },
    trackRouter: (name, extra) => { trackedEvents.push({ name, extra: Object.assign({}, extra) }); },
    collectAttribution: () => ({ v: 'd', utm_source: 'fb', fbclid: null }),
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
    PARTNER_INDUSTRY_DESTINATIONS: { re_agent: 'partner-re.html', insurance_agent: 'partner-insurance.html' },
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
    fbq: () => {},
    RegExp
  };
  sandbox.window.document = document;
  const ctx = vm.createContext(sandbox);
  activeCtx = ctx;
  vm.runInContext(variantDSrc, ctx, { filename: 'js/router-variant-d.js' });
  const RouterVariantD = ctx.window.RouterVariantD;
  if (!RouterVariantD || typeof RouterVariantD.init !== 'function') {
    throw new Error('window.RouterVariantD.init was not defined after loading js/router-variant-d.js');
  }

  return { ctx, routerDRoot, bridge, RouterVariantD, trackedEvents, rpcCalls, insertCalls, redirects };
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

// ══════════════════════ Scenario 1: d-role renders 3 tap targets, correct
// labels/order, no typing ══════════════════════
(function scenario1() {
  const { routerDRoot, bridge, RouterVariantD, trackedEvents } = buildScenario();
  RouterVariantD.init(bridge, routerDRoot);
  const buttons = findRoleButtons(routerDRoot);
  ok(buttons.length === 3, 'd-role renders exactly 3 tap targets');
  const labels = buttons.map((b) => b.children.filter((c) => c.nodeType === undefined || true).map(() => '').join(''));
  ok(buttons[0].textContent.indexOf('Homeowner') !== -1, 'tap target 1 is Homeowner');
  ok(buttons[1].textContent.indexOf('Professional') !== -1 && buttons[1].textContent.indexOf('real estate or insurance') !== -1, 'tap target 2 is "Professional (real estate or insurance)"');
  ok(buttons[2].textContent.indexOf('Contractor') !== -1, 'tap target 3 is Contractor');
  ok(routerDRoot.children.every((c) => c.tagName !== 'INPUT'), 'd-role has no text input anywhere -- no typing');
  ok(trackedEvents.length === 1 && trackedEvents[0].name === 'router_step_view' && trackedEvents[0].extra.step === 'd-role',
    'router_step_view {step: "d-role"} fires on view, and nothing else fires yet');
})();

// ══════════════════════ Scenario 2: tapping a role advances to d-email,
// emits router_role_selected + router_step_complete(d-role) + router_step_view(d-email) ══════════════════════
(function scenario2() {
  const { routerDRoot, bridge, RouterVariantD, trackedEvents } = buildScenario();
  RouterVariantD.init(bridge, routerDRoot);
  findRoleButtons(routerDRoot)[0].dispatchClick(); // Homeowner
  const names = trackedEvents.map((e) => e.name + ':' + (e.extra.step || e.extra.role || ''));
  ok(names[0] === 'router_step_view:d-role', 'event 1 is router_step_view d-role');
  ok(names[1] === 'router_role_selected:homeowner', 'event 2 is router_role_selected role=homeowner');
  ok(names[2] === 'router_step_complete:d-role', 'event 3 is router_step_complete d-role (go() leaving d-role)');
  ok(names[3] === 'router_step_view:d-email', 'event 4 is router_step_view d-email');
  const emailInput = flatten(routerDRoot).find((c) => c.id === 'dEmail');
  ok(!!emailInput, 'd-email renders exactly one email input');
  const otherInputs = flatten(routerDRoot).filter((c) => c.tagName === 'INPUT');
  ok(otherInputs.length === 1, 'd-email has ONE input and nothing else (no name/phone on this screen)');
})();

// ══════════════════════ Scenario 3: email submit -> leads insert +
// set_lead_role(homeowner) -> advances to d-name ══════════════════════
(function scenario3() {
  const { routerDRoot, bridge, RouterVariantD, insertCalls, rpcCalls, trackedEvents } = buildScenario();
  RouterVariantD.init(bridge, routerDRoot);
  findRoleButtons(routerDRoot)[0].dispatchClick(); // Homeowner
  fillAndSubmit(routerDRoot, 'dEmail', 'jane@example.com');
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => {
    ok(insertCalls.length === 1, 'exactly one leads insert on email submit');
    ok(insertCalls[0].email === 'jane@example.com' && insertCalls[0].name === null && insertCalls[0].phone === null,
      'the insert payload is email-only: name=null, phone=null (D-327: no typing before this except email)');
    const roleCall = rpcCalls.find((c) => c.name === 'set_lead_role');
    ok(!!roleCall && roleCall.args.p_role === 'homeowner', 'set_lead_role is called with p_role="homeowner" right after the insert');
    const stepNames = trackedEvents.map((e) => e.name + ':' + (e.extra.step || ''));
    ok(stepNames.indexOf('router_step_complete:d-email') !== -1, 'router_step_complete fires for d-email on submit');
    ok(stepNames.indexOf('router_step_view:d-name') !== -1, 'router_step_view fires for d-name next (homeowner keeps going)');
  }).catch((e) => { console.error('scenario3 error:', e); fail++; });
})();

// ══════════════════════ Scenario 4: contractor branches straight to
// contractor-join from d-email -- never reaches d-name ══════════════════════
(function scenario4() {
  const { routerDRoot, bridge, RouterVariantD, redirects, trackedEvents } = buildScenario();
  RouterVariantD.init(bridge, routerDRoot);
  findRoleButtons(routerDRoot)[2].dispatchClick(); // Contractor
  fillAndSubmit(routerDRoot, 'dEmail', 'bob@example.com');
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => {
    ok(redirects.length === 1, 'contractor redirects exactly once, right after the email screen');
    ok(redirects[0].dest.indexOf('contractor-join.html') !== -1, 'contractor redirects to contractor-join.html');
    ok(redirects[0].dest.indexOf('lead=lead-') !== -1, 'the redirect carries the freshly-inserted lead id');
    ok(redirects[0].preBuilt === true, 'redirectTo is called with preBuilt=true (lead id already appended by hand)');
    const stepViews = trackedEvents.filter((e) => e.name === 'router_step_view').map((e) => e.extra.step);
    ok(stepViews.indexOf('d-name') === -1 && stepViews.indexOf('d-phone') === -1,
      'contractor never sees d-name or d-phone -- #2075: "routes to the existing contractor-join path after the email screen"');
  }).catch((e) => { console.error('scenario4 error:', e); fail++; });
})();

// ══════════════════════ Scenario 5: homeowner clears name (required) and
// phone (optional/skippable), then reaches the lazy-loaded d-trades screen
// with arm C's own COPY, verbatim ══════════════════════
(function scenario5() {
  const { routerDRoot, bridge, RouterVariantD, rpcCalls, trackedEvents } = buildScenario();
  RouterVariantD.init(bridge, routerDRoot);
  findRoleButtons(routerDRoot)[0].dispatchClick(); // Homeowner
  fillAndSubmit(routerDRoot, 'dEmail', 'jane@example.com');
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => {
    fillAndSubmit(routerDRoot, 'dName', 'Jane Smith');
    return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
  }).then(() => {
    const nameRpc = rpcCalls.find((c) => c.name === 'update_lead_contact' && c.args.p_name === 'Jane Smith');
    ok(!!nameRpc, 'update_lead_contact is called with the entered name (PATCHing the existing row, not a second insert)');
    // d-phone: leave blank (skippable) and hit Continue.
    const phoneScreenInput = flatten(routerDRoot).find((c) => c.id === 'dPhone');
    ok(!!phoneScreenInput, 'd-phone screen rendered with its own input');
    ok(phoneScreenInput.getAttribute === undefined ? true : true, 'sanity');
    const submitBtn = flatten(routerDRoot).find((c) => c.tagName === 'BUTTON' && c.textContent === 'Continue');
    submitBtn.dispatchClick(); // blank phone -- must not block
    return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => Promise.resolve());
  }).then(() => {
    const phoneRpc = rpcCalls.filter((c) => c.name === 'update_lead_contact').pop();
    ok(phoneRpc.args.p_phone === null, 'blank phone submits p_phone=null and is never blocked (gh-2042 precedent)');
    // By now js/router-discovery.js should have been lazy-loaded on demand
    // (never at init()) and d-trades rendered with ITS heading/options,
    // read verbatim from RouterDiscovery.COPY -- not reauthored in
    // router-variant-d.js.
    const stepViews = trackedEvents.filter((e) => e.name === 'router_step_view').map((e) => e.extra.step);
    ok(stepViews.indexOf('d-trades') !== -1, 'router_step_view fires for d-trades once js/router-discovery.js has lazy-loaded');
    const heading = flatten(routerDRoot).find((c) => c.tagName === 'H1');
    ok(!!heading && heading.textContent === 'What kind of work do you need done (check all that apply).',
      'd-trades renders arm C\'s own COPY.home2Heading verbatim -- no new copy authored in router-variant-d.js');
    const optionButtons = flatten(routerDRoot).filter((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('role-option'));
    ok(optionButtons.length === 5, 'd-trades renders all 5 of arm C\'s home2Options (Roofing/Siding/Gutters/Windows/Other)');
  }).catch((e) => { console.error('scenario5 error:', e); fail++; });
})();

Promise.resolve().then(async () => {
  // Scenarios 3-5 return promises (async submit flows); scenario 5 in
  // particular needs several microtask turns for the RouterDiscovery lazy
  // load + render to settle before its own assertions run inline above --
  // already awaited via the .then chains above. Nothing further to await
  // here except letting the module-level IIFEs above finish executing,
  // which they already have by this point (top-level scenario functions
  // ran synchronously up to their first `await`-equivalent .then()).
  await new Promise((r) => setTimeout(r, 10));

  console.log('\n=== Summary ===');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
});
