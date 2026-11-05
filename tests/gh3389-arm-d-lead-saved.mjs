/**
 * gh-3389 (D-409), review fix on PR #3397 -- Arm D (the arm a bare /start serves, LIVE_VARIANTS = ['d']) fires the HeyCatch
 * goal `lead_saved` through window.__oqHcTrack('lead_saved'), name only, once, and only after the leads insert has resolved,
 * for a homeowner lead.
 *
 * Same approach as tests/gh1940-arm-d-contact-submitted.mjs: js/router-variant-d.js is loaded verbatim into a Node `vm`
 * behind a small DOM shim; nothing is written anywhere. Here the leads insert is GATED (a promise the test releases) and the
 * hook and the insert share one ordered log, so a hook that fires before the insert resolved is caught by ORDER, not by count.
 *
 * NEGATIVE CONTROLS (run every time, not only by hand): the same scenarios run against mutated copies of the source. Each
 * mutant must make at least one scenario FAIL:
 *   M1 the call removed (Arm D never fires)            M2 the call moved to the click handler, before the insert
 *   M3 the once-flag removed                           M4 the homeowner gate removed
 *   M5 properties passed to the hook                   M6 the call made unguarded (throws into the page when the hook throws)
 *
 * Run: node tests/gh3389-arm-d-lead-saved.mjs
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const variantDSrcReal = fs.readFileSync(path.join(repoRoot, 'js', 'router-variant-d.js'), 'utf8');
const discoverySrc = fs.readFileSync(path.join(repoRoot, 'js', 'router-discovery.js'), 'utf8');

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
  const log = [];
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
      log.push('insert-called');
      if (opts.failInsert) return Promise.reject(new Error('insert failed (test)'));
      const id = 'lead-' + (nextLeadId++);
      const gate = opts.gate || Promise.resolve();
      return gate.then(() => { log.push('insert-resolved'); return id; });
    },
    appendParams: (base, obj) => {
      const parts = Object.keys(obj).filter((k) => obj[k]).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
      if (!parts.length) return base;
      return base + (base.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
    },
    redirectTo: (dest, preBuilt) => { redirects.push({ dest, preBuilt }); },
    showError: (msg) => { if (!opts.failInsert && opts.hook !== 'throws') throw new Error('bridge.showError called unexpectedly: ' + msg); },
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
  const hookCalls = [];
  if (opts.hook !== 'absent') {
    sandbox.window.__oqHcTrack = function () {
      hookCalls.push(Array.from(arguments)); log.push('lead_saved');
      if (opts.hook === 'throws') throw new Error('hook down (test)');
    };
  }
  const ctx = vm.createContext(sandbox);
  ctxCell.ctx = ctx;
  vm.runInContext(src || variantDSrcReal, ctx, { filename: 'js/router-variant-d.js' });
  const RouterVariantD = ctx.window.RouterVariantD;
  if (!RouterVariantD || typeof RouterVariantD.init !== 'function') {
    throw new Error('window.RouterVariantD.init was not defined after loading js/router-variant-d.js');
  }

  return { ctx, routerDRoot, bridge, RouterVariantD, trackedEvents, rpcCalls, insertCalls, redirects, leadEvents, hookCalls, log };
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

function deferred() { let res; const p = new Promise((r) => { res = r; }); return { p, res }; }

// Each scenario returns [label, boolean] checks, so the same code judges the shipped source and every mutant.
async function scenarios(src) {
  const out = [];
  const chk = (label, cond) => out.push([label, !!cond]);
  const savedCalls = (s) => s.hookCalls.filter((c) => c[0] === 'lead_saved');

  // 1. homeowner, insert held open: nothing may fire until the insert resolves; then exactly one, name only, after it.
  {
    const g = deferred();
    const s = buildScenario(src, { gate: g.p });
    s.RouterVariantD.init(s.bridge, s.routerDRoot);
    findRoleButtons(s.routerDRoot)[0].dispatchClick();
    fillAndSubmit(s.routerDRoot, 'dEmail', 'jane@example.com');
    await tick(6);
    chk('homeowner, insert still pending: lead_saved has NOT fired', s.hookCalls.length === 0 && s.insertCalls.length === 1);
    g.res();
    await tick(10);
    chk('homeowner, insert resolved: lead_saved fired exactly once', s.hookCalls.length === 1);
    chk('homeowner: the hook got the name and NOTHING else (no properties, no email, no lead id)', s.hookCalls.length === 1 && JSON.stringify(s.hookCalls[0]) === '["lead_saved"]');
    const ia = s.log.indexOf('insert-resolved'), ev = s.log.indexOf('lead_saved');
    chk('homeowner: order is insert-called, insert-resolved, lead_saved', ia !== -1 && ev !== -1 && s.log.indexOf('insert-called') < ia && ia < ev);
    chk('homeowner: the typed email appears in no hook argument', !JSON.stringify(s.hookCalls).includes('jane@example.com'));
  }

  // 2. insert fails: no lead, no event.
  {
    const s = buildScenario(src, { failInsert: true });
    const origError = console.error; console.error = () => {};
    try {
      s.RouterVariantD.init(s.bridge, s.routerDRoot);
      findRoleButtons(s.routerDRoot)[0].dispatchClick();
      fillAndSubmit(s.routerDRoot, 'dEmail', 'jane@example.com');
      await tick(8);
    } finally { console.error = origError; }
    chk('insert fails: lead_saved never fires', s.hookCalls.length === 0 && s.log.indexOf('insert-resolved') === -1);
  }

  // 3. Back and resubmit a corrected email: one lead, one event in total.
  {
    const s = buildScenario(src);
    s.RouterVariantD.init(s.bridge, s.routerDRoot);
    findRoleButtons(s.routerDRoot)[0].dispatchClick();
    fillAndSubmit(s.routerDRoot, 'dEmail', 'typo@example.com');
    await tick(8);
    const back = flatten(s.routerDRoot).find((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('router-back'));
    back.dispatchClick();
    await tick(2);
    fillAndSubmit(s.routerDRoot, 'dEmail', 'fixed@example.com');
    await tick(8);
    chk('resubmit after Back: one insert and one lead_saved in total', s.insertCalls.length === 1 && s.hookCalls.length === 1);
  }

  // 4. contractor and professional rows are not homeowner leads.
  {
    const s = buildScenario(src);
    s.RouterVariantD.init(s.bridge, s.routerDRoot);
    findRoleButtons(s.routerDRoot)[2].dispatchClick();
    fillAndSubmit(s.routerDRoot, 'dEmail', 'pro@example.com');
    await tick(8);
    chk('contractor: lead saved, lead_saved does not fire', s.insertCalls.length === 1 && s.hookCalls.length === 0);
    const p = buildScenario(src);
    p.RouterVariantD.init(p.bridge, p.routerDRoot);
    findRoleButtons(p.routerDRoot)[1].dispatchClick();
    fillAndSubmit(p.routerDRoot, 'dEmail', 'agent@example.com');
    await tick(8);
    chk('professional: lead saved, lead_saved does not fire', p.insertCalls.length === 1 && p.hookCalls.length === 0);
  }

  // 5. the hook is absent (HeyCatch did not load) or throws: the signup flow is unaffected.
  {
    const s = buildScenario(src, { hook: 'absent' });
    s.RouterVariantD.init(s.bridge, s.routerDRoot);
    findRoleButtons(s.routerDRoot)[0].dispatchClick();
    fillAndSubmit(s.routerDRoot, 'dEmail', 'jane@example.com');
    await tick(8);
    const nameInput = flatten(s.routerDRoot).find((ch) => ch.id === 'dName');
    chk('no hook: lead saved and the d-contact screen is reached, no error', s.insertCalls.length === 1 && !!nameInput);
    const t = buildScenario(src, { hook: 'throws' });
    let threw = false;
    try {
      t.RouterVariantD.init(t.bridge, t.routerDRoot);
      findRoleButtons(t.routerDRoot)[0].dispatchClick();
      fillAndSubmit(t.routerDRoot, 'dEmail', 'jane@example.com');
      await tick(8);
    } catch (e) { threw = true; }
    const nameInput2 = flatten(t.routerDRoot).find((ch) => ch.id === 'dName');
    chk('hook throws: the visitor still reaches d-contact, nothing thrown into the page', !threw && !!nameInput2);
  }

  // 6. the ?entry=home path (role implied, d-role skipped) is a homeowner path too.
  {
    const s = buildScenario(src);
    s.bridge.homeEntry = { skipRole: true };
    s.RouterVariantD.init(s.bridge, s.routerDRoot);
    fillAndSubmit(s.routerDRoot, 'dEmail', 'home@example.com');
    await tick(8);
    chk('?entry=home homeowner: lead_saved fires once after the insert', s.hookCalls.length === 1 && s.log.indexOf('insert-resolved') < s.log.indexOf('lead_saved'));
  }
  return out;
}

function mutate(src, from, to) {
  if (src.split(from).length !== 2) throw new Error('mutation anchor not found exactly once: ' + from);
  return src.replace(from, to);
}
const CALL = "if (typeof window.__oqHcTrack === 'function') window.__oqHcTrack('lead_saved');";
const mutants = {
  'M1 call removed': (s) => mutate(s, CALL, ''),
  'M2 call moved before the insert (into the submit handler)': (s) => mutate(mutate(s, '        fireHcLeadSaved(); // gh-3389: the leads insert has resolved\n', ''),
    "      bridge.insertFreshLead(null, value, null, undefined, undefined, homeZipExtra).then(", "      hcLeadSavedFired = false; leadId = leadId || 'early'; fireHcLeadSaved(); leadId = null;\n      bridge.insertFreshLead(null, value, null, undefined, undefined, homeZipExtra).then("),
  'M3 once-flag removed': (s) => mutate(s, 'if (hcLeadSavedFired || role', 'if (role'),
  'M4 homeowner gate removed': (s) => mutate(s, " || role !== 'homeowner' || !leadId) return;", " || !leadId) return;"),
  'M5 properties passed': (s) => mutate(s, "window.__oqHcTrack('lead_saved');", "window.__oqHcTrack('lead_saved', { email: email });"),
  'M6 call unguarded': (s) => mutate(s, 'try { ' + CALL + ' } catch (e) {}', CALL)
};

(async function main() {
  let fail = 0;
  const real = await scenarios(variantDSrcReal);
  for (const [label, okk] of real) { console.log((okk ? 'PASS: ' : 'FAIL: ') + label); if (!okk) fail++; }
  for (const [name, fn] of Object.entries(mutants)) {
    const m = fn(variantDSrcReal);
    if (m === variantDSrcReal) { console.log('FAIL: negative control ' + name + ' did not change the source'); fail++; continue; }
    let res;
    const origErr = console.error; console.error = () => {};
    try { res = await scenarios(m); } catch (e) { res = [['mutant run threw: ' + e.message, false]]; } finally { console.error = origErr; }
    const caught = res.filter(([, okk]) => !okk).map(([l]) => l);
    const good = caught.length > 0;
    console.log((good ? 'PASS: ' : 'FAIL: ') + 'negative control ' + name + (good ? ' is caught by: ' + caught[0] : ' PASSES every scenario (the test cannot see it)'));
    if (!good) fail++;
  }
  console.log('\n' + (fail ? fail + ' check(s) failed' : 'all gh3389 Arm D lead_saved checks passed'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test error:', e); process.exit(1); });
