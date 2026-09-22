/**
 * gh-2084 — Variant E, Professional path: Real Estate / Insurance
 * branches, built from Sloane's approved script (#2077 close,
 * ceo57-sloane-variant-e-pro-20260921.md).
 *
 * Same harness philosophy as tests/gh2076-variant-e.mjs (copied here,
 * not imported, so this file stays a single self-contained suite): no
 * real browser engine / jsdom in this repo, so this drives the ACTUAL
 * files (js/router-variant-e.js and js/router-discovery.js) inside a
 * Node `vm` context behind a minimal hand-rolled DOM shim.
 *
 * The exposition copy is asserted VERBATIM against the approved report
 * file itself (read directly off disk below, not retyped as a second
 * hardcoded copy this suite could drift from) -- see extractPage().
 *
 * bridge.sb (Supabase) is stubbed, NEVER real, and the Supabase host is
 * never touched — this suite asserts on the INSERT/RPC PAYLOADS the
 * module would have sent, not on a live leads row. No real database
 * write ever happens from this file.
 *
 * Run: node tests/gh2084-variant-e-pro.mjs
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

// ── Authoritative source text: Sloane's approved script, committed
// into the repo verbatim (gh-2084 review round 1, item 3) as
// tests/fixtures/gh2084-variant-e-pro-script.md -- a byte-for-byte copy
// of ceo57-sloane-variant-e-pro-20260921.md, so this suite runs in any
// checkout instead of depending on a path under the author's own device
// home directory. Never retyped as a second hardcoded copy this suite
// could silently drift from. Page N's exposition text is every
// non-bracket line between "PAGE N:" and the next blank line. ──
const reportPath = path.join(repoRoot, 'tests', 'fixtures', 'gh2084-variant-e-pro-script.md');
const reportSrc = fs.readFileSync(reportPath, 'utf8');
function extractPage(label) {
  const lines = reportSrc.split('\n');
  const headerRe = new RegExp('^PAGE ' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(:| —)');
  const idx = lines.findIndex((l) => headerRe.test(l));
  if (idx === -1) throw new Error('report file: could not find "PAGE ' + label + '"');
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') break;
    if (line.trim().charAt(0) === '[') continue;
    out.push(line.trim());
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
const REPORT_COPY = {
  p2: extractPage('2'),
  p4a: extractPage('4(a)'),
  p6a: extractPage('6(a)'),
  p8a: extractPage('8(a)'),
  p10a: extractPage('10(a)'),
  p4b: extractPage('4(b)'),
  p6b: extractPage('6(b)'),
  p8b: extractPage('8(b)'),
  p10b: extractPage('10(b)'),
  p12b: extractPage('12(b)'),
  p14b: extractPage('14(b)'),
  p16b: extractPage('16(b)')
};

// ── Minimal DOM shim -- copied from tests/gh2076-variant-e.mjs's own
// shim verbatim (same two files touch the same DOM surface). Not a
// general-purpose DOM. ──
function makeDom(ctxCell) {
  const registry = {};
  const clockState = { now: 1000000 };
  function syncClassName(el) { el.className = el._classes.join(' '); }
  function dispatchDomEvent(target, type, opts) {
    if (!opts || opts.advanceClock !== false) { clockState.now += 1000; }
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
  const allBodyTexts = [];
  let nextLeadId = 1;

  const bridge = {
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

  return { ctx, routerERoot, bridge, RouterVariantE, trackedEvents, rpcCalls, insertCalls, redirects, allBodyTexts, dispatchPageshow: (persisted) => ctx.window.dispatchPageshow(persisted), clockState };
}

function flatten(el) {
  const out = [el];
  (el.children || []).forEach((c) => { out.push(...flatten(c)); });
  return out;
}
function findOptionButtons(root) {
  return flatten(root).filter((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('role-option'));
}
function findButtonByText(root, text) {
  return flatten(root).find((c) => c.tagName === 'BUTTON' && c.textContent === text);
}
function findContinueButton(root) { return findButtonByText(root, 'Continue'); }
function findNextButton(root) { return findButtonByText(root, 'Next'); }
function bodyTexts(root) {
  return flatten(root).filter((c) => c.tagName === 'P' && c.className.split(' ').includes('router-sub')).map((c) => c.textContent);
}
function inputTypes(root) {
  return flatten(root).filter((c) => c.tagName === 'INPUT').map((c) => c.type);
}
function fillAndSubmit(root, inputId, value) {
  const input = flatten(root).find((ch) => ch.id === inputId);
  input.value = value;
  findContinueButton(root).dispatchClick();
}
function settle() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => Promise.resolve());
}
function stepNames(trackedEvents) {
  return trackedEvents.map((e) => e.name + ':' + (e.extra.step || e.extra.role || ''));
}

// Drives from init() through e-p1 (professional tap) and e-pro-2/e-pro-3
// into the requested branch ('re_agent' or 'insurance_agent'), returning
// once the branch's own first exposition screen (e-pro-4a/e-pro-4b) is
// rendered. Collects every P.router-sub body paragraph seen along the way
// into `allBodyTexts` (mutated in place) so callers can assert on the
// full set at the end of a walk.
function driveToIndustry(routerERoot, industryCode, allBodyTexts) {
  return settle().then(() => {
    // e-p1: role tap -- option index 2 is "I am a professional...".
    allBodyTexts.push(...bodyTexts(routerERoot));
    const roleButtons = findOptionButtons(routerERoot);
    roleButtons[1].dispatchClick();
    return settle();
  }).then(() => {
    // e-pro-2: shared professional exposition -- gh-2084 review round 1
    // item 4: pro exposition screens say "Next", not "Continue".
    allBodyTexts.push(...bodyTexts(routerERoot));
    findNextButton(routerERoot).dispatchClick();
    return settle();
  }).then(() => {
    // e-pro-3: industry picker.
    allBodyTexts.push(...bodyTexts(routerERoot));
    const order = ['re_agent', 'insurance_agent', 'home_inspector', 'adjuster', 'other'];
    const idx = order.indexOf(industryCode);
    findOptionButtons(routerERoot)[idx].dispatchClick();
    return settle();
  });
}

// Walks a single-question screen: records body text (none expected), picks
// option 0, settles.
function pickOption(routerERoot, allBodyTexts) {
  allBodyTexts.push(...bodyTexts(routerERoot));
  findOptionButtons(routerERoot)[0].dispatchClick();
  return settle();
}
// gh-2084 review round 1, item 4: pro exposition screens use a "Next"
// button, not "Continue" -- the homeowner path's own exposition screens
// (not exercised by this suite) are unaffected.
function passExposition(routerERoot, allBodyTexts) {
  allBodyTexts.push(...bodyTexts(routerERoot));
  findNextButton(routerERoot).dispatchClick();
  return settle();
}

// ═══ Scenario 1: Real Estate branch, full walk, exact step-id sequence,
// verbatim exposition copy, fee sentence / D-266 placement, no phone
// field anywhere, hand-off insert + set_lead_role + redirect. ═══
(function scenario1() {
  const { routerERoot, bridge, RouterVariantE, trackedEvents, rpcCalls, insertCalls, redirects, allBodyTexts } = buildScenario({});
  RouterVariantE.init(bridge, routerERoot);
  return driveToIndustry(routerERoot, 're_agent', allBodyTexts).then(() => {
    // e-pro-4a exposition
    return passExposition(routerERoot, allBodyTexts);
  }).then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-5a
    .then(() => {
      // e-pro-5-5a: name
      allBodyTexts.push(...bodyTexts(routerERoot));
      ok(inputTypes(routerERoot).indexOf('tel') === -1, 'e-pro-5-5a renders no phone input');
      fillAndSubmit(routerERoot, 'eProName', 'Pat Realtor');
      return settle();
    }).then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-6a
    .then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-7a
    .then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-8a
    .then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-9a
    .then(() => {
      // e-pro-9-5a: email -- gh-2084 review round 1, item 1: this is now
      // the branch's FIRST COMMITMENT (insert + set_lead_role), the same
      // point arm D/E's homeowner path writes its own first row.
      allBodyTexts.push(...bodyTexts(routerERoot));
      ok(inputTypes(routerERoot).indexOf('tel') === -1, 'e-pro-9-5a renders no phone input');
      fillAndSubmit(routerERoot, 'eProEmail', 'pat@example.com');
      return settle();
    }).then(() => {
      ok(insertCalls.length === 1, 'the lead insert happens at the EMAIL screen (e-pro-9-5a), not the close screen');
      ok(insertCalls[0].name === 'Pat Realtor' && insertCalls[0].email === 'pat@example.com' && insertCalls[0].phone === null,
        'the insert carries the name/email captured so far and no phone');
      const roleCall = rpcCalls.find((c) => c.name === 'set_lead_role');
      ok(!!roleCall && roleCall.args.p_role === 'referral_partner' && roleCall.args.p_partner_industry === 're_agent',
        'set_lead_role is called with role=referral_partner, partner_industry=re_agent, right after the email-screen insert');
    }).then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-10a
    .then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-11a
    .then(() => {
      // e-pro-12a: close/hand-off screen -- leadId already exists; "Next"
      // now PATCHes via update_lead_contact rather than inserting.
      const texts = bodyTexts(routerERoot);
      allBodyTexts.push(...texts);
      ok(inputTypes(routerERoot).indexOf('tel') === -1, 'e-pro-12a (hand-off) renders no phone input -- locked default 4, no phone re-ask');
      ok(texts.indexOf('$200 when a homeowner you refer completes a project of $10,000 or more. $50 on the same terms for referrals from partners you recruit.') !== -1,
        'e-pro-12a shows the fee sentence, verbatim, unmoved from realtorClose[1]');
      ok(texts.indexOf('Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.') !== -1,
        'e-pro-12a shows the D-266 disclaimer, verbatim, unmoved from realtorClose[2]');
      const nextBtn = findNextButton(routerERoot);
      ok(!!nextBtn, 'e-pro-12a has a "Next" control (not "Continue") for the hand-off tap');
      nextBtn.dispatchClick();
      // Double-submit guard: a second click on the SAME button reference,
      // landing while the PATCH is still in flight, must be a no-op --
      // reusing the reference (not re-querying by its now-changed label)
      // mirrors what a real double-tap actually hits.
      nextBtn.dispatchClick();
      const backBtn = flatten(routerERoot).find((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('router-back'));
      ok(!!backBtn && backBtn.disabled === true, 'Back is disabled while the hand-off PATCH is in flight');
      ok(nextBtn.disabled === true, 'Next is disabled while the hand-off PATCH is in flight');
      return settle();
    }).then(() => {
      ok(insertCalls.length === 1, 'still exactly ONE lead insert for the whole RE branch on the happy path -- the close screen never inserts a second row (the double-tap above did not either)');
      const patchCalls = rpcCalls.filter((c) => c.name === 'update_lead_contact');
      ok(patchCalls.length === 1 && patchCalls[0].args.p_lead_id === 'lead-1' && patchCalls[0].args.p_phone === null,
        'the close screen PATCHes the existing lead row via update_lead_contact, exactly once, with no phone');
      ok(redirects.length === 1 && redirects[0].dest.indexOf('partner-re.html') === 0 && redirects[0].dest.indexOf('lead=lead-1') !== -1,
        'hand-off redirects straight to partner-re.html with the SAME lead id the email screen created -- no phone screen in between');

      const seq = stepNames(trackedEvents).filter((s) => s.indexOf('router_step_view:') === 0);
      const expected = ['e-p1', 'e-pro-2', 'e-pro-3', 'e-pro-4a', 'e-pro-5a', 'e-pro-5-5a', 'e-pro-6a', 'e-pro-7a', 'e-pro-8a', 'e-pro-9a', 'e-pro-9-5a', 'e-pro-10a', 'e-pro-11a', 'e-pro-12a']
        .map((s) => 'router_step_view:' + s);
      ok(JSON.stringify(seq) === JSON.stringify(expected), 'RE branch fires router_step_view with the exact e-pro-* step sequence, including every exposition page: ' + JSON.stringify(seq));

      ok(allBodyTexts.indexOf(REPORT_COPY.p2) !== -1, 'e-pro-2 copy matches the approved report verbatim');
      ok(allBodyTexts.indexOf(REPORT_COPY.p4a) !== -1, 'e-pro-4a copy matches the approved report verbatim (Alt A, locked default 1)');
      ok(allBodyTexts.indexOf(REPORT_COPY.p6a) !== -1, 'e-pro-6a copy matches the approved report verbatim');
      ok(allBodyTexts.indexOf(REPORT_COPY.p8a) !== -1, 'e-pro-8a copy matches the approved report verbatim');
      ok(allBodyTexts.indexOf(REPORT_COPY.p10a) !== -1, 'e-pro-10a copy matches the approved report verbatim');

      const feeOccurrences = allBodyTexts.filter((t) => t.indexOf('$200 when a homeowner you refer completes') !== -1).length;
      ok(feeOccurrences === 1, 'the fee sentence appears EXACTLY once across the whole RE walk (close screen only)');
      ok(allBodyTexts.every((t) => t.indexOf('40%') === -1), 'the string "40%" never appears anywhere on the RE branch');
    }).catch((e) => { console.error('scenario1 error:', e); fail++; });
})();

// ═══ Scenario 2: Insurance branch, full walk (7 questions, 3 shared +
// 14 branch-specific = 17 pages), exact step-id sequence, verbatim
// exposition copy including the locked-default Alt A on page 14(b), fee
// sentence / D-266 placement, no phone field, hand-off. ═══
(function scenario2() {
  const { routerERoot, bridge, RouterVariantE, trackedEvents, rpcCalls, insertCalls, redirects, allBodyTexts } = buildScenario({});
  RouterVariantE.init(bridge, routerERoot);
  return driveToIndustry(routerERoot, 'insurance_agent', allBodyTexts).then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-4b
    .then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-5b
    .then(() => {
      allBodyTexts.push(...bodyTexts(routerERoot));
      fillAndSubmit(routerERoot, 'eProName', 'Jamie Adjuster');
      return settle();
    }) // e-pro-5-5b
    .then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-6b
    .then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-7b
    .then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-8b
    .then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-9b
    .then(() => {
      allBodyTexts.push(...bodyTexts(routerERoot));
      fillAndSubmit(routerERoot, 'eProEmail', 'jamie@example.com');
      return settle();
    }) // e-pro-9-5b -- gh-2084 review round 1, item 1: FIRST COMMITMENT
    .then(() => {
      ok(insertCalls.length === 1, 'the lead insert happens at the EMAIL screen (e-pro-9-5b), not the close screen');
      ok(insertCalls[0].name === 'Jamie Adjuster' && insertCalls[0].email === 'jamie@example.com' && insertCalls[0].phone === null,
        'the insert carries the name/email captured so far and no phone');
      const roleCall = rpcCalls.find((c) => c.name === 'set_lead_role');
      ok(!!roleCall && roleCall.args.p_role === 'referral_partner' && roleCall.args.p_partner_industry === 'insurance_agent',
        'set_lead_role is called with role=referral_partner, partner_industry=insurance_agent, right after the email-screen insert');
    })
    .then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-10b
    .then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-11b
    .then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-12b
    .then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-13b
    .then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-14b
    .then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-15b
    .then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-16b
    .then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-17b
    .then(() => {
      const texts = bodyTexts(routerERoot);
      allBodyTexts.push(...texts);
      ok(inputTypes(routerERoot).indexOf('tel') === -1, 'e-pro-18b (hand-off) renders no phone input');
      ok(texts.indexOf('$200 when a homeowner you refer completes a project of $10,000 or more. $50 on the same terms for referrals from partners you recruit.') !== -1,
        'e-pro-18b shows the fee sentence, verbatim, unmoved from insClose[1]');
      ok(texts.indexOf('Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.') !== -1,
        'e-pro-18b shows the D-266 disclaimer, verbatim, unmoved from insClose[2]');
      ok(texts.indexOf('It costs nothing to join.') !== -1, 'e-pro-18b keeps insClose\'s own fourth paragraph verbatim');
      findNextButton(routerERoot).dispatchClick();
      return settle();
    }).then(() => {
      ok(insertCalls.length === 1, 'still exactly ONE lead insert for the whole Insurance branch on the happy path -- the close screen never inserts a second row');
      const patchCalls = rpcCalls.filter((c) => c.name === 'update_lead_contact');
      ok(patchCalls.length === 1 && patchCalls[0].args.p_lead_id === 'lead-1' && patchCalls[0].args.p_phone === null,
        'the close screen PATCHes the existing lead row via update_lead_contact, exactly once, with no phone');
      ok(redirects.length === 1 && redirects[0].dest.indexOf('partner-insurance.html') === 0 && redirects[0].dest.indexOf('lead=lead-1') !== -1,
        'hand-off redirects straight to partner-insurance.html with the SAME lead id the email screen created');

      const seq = stepNames(trackedEvents).filter((s) => s.indexOf('router_step_view:') === 0);
      const expected = ['e-p1', 'e-pro-2', 'e-pro-3', 'e-pro-4b', 'e-pro-5b', 'e-pro-5-5b', 'e-pro-6b', 'e-pro-7b', 'e-pro-8b', 'e-pro-9b', 'e-pro-9-5b',
        'e-pro-10b', 'e-pro-11b', 'e-pro-12b', 'e-pro-13b', 'e-pro-14b', 'e-pro-15b', 'e-pro-16b', 'e-pro-17b', 'e-pro-18b']
        .map((s) => 'router_step_view:' + s);
      ok(JSON.stringify(seq) === JSON.stringify(expected), 'Insurance branch fires router_step_view with the exact e-pro-* step sequence, including every exposition page (' + seq.length + ' steps): ' + JSON.stringify(seq));

      ok(allBodyTexts.indexOf(REPORT_COPY.p4b) !== -1, 'e-pro-4b copy matches the approved report verbatim');
      ok(allBodyTexts.indexOf(REPORT_COPY.p6b) !== -1, 'e-pro-6b copy matches the approved report verbatim');
      ok(allBodyTexts.indexOf(REPORT_COPY.p8b) !== -1, 'e-pro-8b copy matches the approved report verbatim');
      ok(allBodyTexts.indexOf(REPORT_COPY.p10b) !== -1, 'e-pro-10b copy matches the approved report verbatim');
      ok(allBodyTexts.indexOf(REPORT_COPY.p12b) !== -1, 'e-pro-12b copy matches the approved report verbatim');
      ok(allBodyTexts.indexOf(REPORT_COPY.p14b) !== -1, 'e-pro-14b copy matches the approved report\'s Alt A (locked default 3), bracket note stripped');
      ok(allBodyTexts.indexOf(REPORT_COPY.p16b) !== -1, 'e-pro-16b copy matches the approved report verbatim');

      const feeOccurrences = allBodyTexts.filter((t) => t.indexOf('$200 when a homeowner you refer completes') !== -1).length;
      ok(feeOccurrences === 1, 'the fee sentence appears EXACTLY once across the whole Insurance walk (close screen only)');
      ok(allBodyTexts.every((t) => t.indexOf('40%') === -1), 'the string "40%" never appears anywhere on the Insurance branch -- the "Nearly 40%" alt for page 14(b) is never wired');
      ok(allBodyTexts.every((t) => t.indexOf('Nearly 40%') === -1), 'the exact rejected alt string "Nearly 40%" never appears on the professional surface');
    }).catch((e) => { console.error('scenario2 error:', e); fail++; });
})();

// ═══ Scenario 3: Home Inspector/Adjuster/Other still route exactly as
// arm C does today (locked default 5) -- straight redirect, no e-pro-*
// question/exposition screens, no lead id. ═══
(function scenario3() {
  const { routerERoot, bridge, RouterVariantE, trackedEvents, redirects, insertCalls, allBodyTexts } = buildScenario({});
  RouterVariantE.init(bridge, routerERoot);
  return driveToIndustry(routerERoot, 'home_inspector', allBodyTexts).then(() => {
    ok(redirects.length === 1 && redirects[0].dest.indexOf('partner-inspectors.html') === 0, 'Home Inspector redirects straight to its destination page, unchanged');
    ok(insertCalls.length === 0, 'no lead is inserted for Home Inspector -- same as arm C today');
    const seq = stepNames(trackedEvents).filter((s) => s.indexOf('router_step_view:') === 0);
    ok(seq.indexOf('router_step_view:e-pro-4a') === -1 && seq.indexOf('router_step_view:e-pro-4b') === -1,
      'Home Inspector never renders any Real Estate/Insurance branch screen');
  }).catch((e) => { console.error('scenario3 error:', e); fail++; });
})();

// ═══ Scenario 4: a ?v=c negative control -- arm C's own router-discovery
// module has no 'e-pro-*' tokens and never fires them; this asserts
// against the source directly (this suite's harness only loads arm E). ═══
(function scenario4() {
  ok(discoverySrc.indexOf('e-pro-') === -1, 'js/router-discovery.js (arm C\'s own module) contains no e-pro-* token -- the professional-path build lives entirely in router-variant-e.js, so a ?v=c visitor is architecturally incapable of reaching any e-pro-* step or exposition copy');
})();

// ═══ Scenario 5 (#2078 hook, not implemented): partner_signup_complete
// is never emitted by this file, and a named hook marks where it goes. ═══
(function scenario5() {
  ok(!/trackRouter\(\s*'partner_signup_complete'/.test(variantESrc), 'router-variant-e.js never CALLS trackRouter with partner_signup_complete -- #2078 has not landed yet (comments may still name the future event)');
  ok(/function HOOK_partnerSignupComplete\(\)/.test(variantESrc), 'a named HOOK_partnerSignupComplete() marks exactly where #2078\'s event will fire');
  ok(/HOOK_partnerSignupComplete\(\);/.test(variantESrc), 'the hook is actually called at the hand-off point (proCloseRenderer\'s own finish())');
})();

// Drives a full RE-branch walk up to and including a rendered e-pro-12a
// close screen (does NOT click its Next button) -- shared by the two
// scenarios below so neither duplicates the whole walk.
function driveToRECloseScreen(routerERoot, allBodyTexts) {
  return driveToIndustry(routerERoot, 're_agent', allBodyTexts)
    .then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-4a
    .then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-5a
    .then(() => { fillAndSubmit(routerERoot, 'eProName', 'Pat Realtor'); return settle(); }) // e-pro-5-5a
    .then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-6a
    .then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-7a
    .then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-8a
    .then(() => pickOption(routerERoot, allBodyTexts)) // e-pro-9a
    .then(() => { fillAndSubmit(routerERoot, 'eProEmail', 'pat@example.com'); return settle(); }) // e-pro-9-5a (insert)
    .then(() => passExposition(routerERoot, allBodyTexts)) // e-pro-10a
    .then(() => pickOption(routerERoot, allBodyTexts)); // e-pro-11a -> lands on e-pro-12a
}

// ═══ Scenario 6 (#2084 review round 1, item 1): the close screen's own
// update_lead_contact PATCH can come back data:false (30-minute window
// expired, or the prefill was already used) -- same fallback e-p13/
// e-p7-5 already have: fall back to a FRESH insertLeadAndSetRole (a
// SECOND row, its own new lead id, its own set_lead_role call) and
// redirect with THAT new id, rather than stranding the visitor. ═══
(function scenario6() {
  const { routerERoot, bridge, RouterVariantE, rpcCalls, insertCalls, redirects, allBodyTexts } = buildScenario({
    rpcResponder: (name) => (name === 'update_lead_contact' ? { data: false, error: null } : { data: true, error: null })
  });
  RouterVariantE.init(bridge, routerERoot);
  return driveToRECloseScreen(routerERoot, allBodyTexts).then(() => {
    findNextButton(routerERoot).dispatchClick();
    return settle();
  }).then(() => {
    ok(insertCalls.length === 2, 'a data:false PATCH result at the close screen falls back to a SECOND insert (the email screen\'s own insert, plus this fallback)');
    const roleCalls = rpcCalls.filter((c) => c.name === 'set_lead_role');
    ok(roleCalls.length === 2, 'set_lead_role is called for BOTH inserts -- the fallback insert is not left with role=NULL');
    ok(redirects.length === 1 && redirects[0].dest.indexOf('lead=lead-2') !== -1,
      'the hand-off redirects with the FALLBACK insert\'s new lead id, not the original (now-stale/consumed) one');
  }).catch((e) => { console.error('scenario6 error:', e); fail++; });
})();

// ═══ Scenario 7 (#2084 review round 1, item 2): a bfcache restore
// (browser Back-then-forward) while the close screen's own "Next" is
// mid-submit must re-enable Next/Back on the re-rendered screen, and a
// second Next tap after that restore must still reuse the SAME leadId
// (PATCH, never a second insert) -- the exact e-p13 fix, extended to
// e-pro-12a/e-pro-18b. ═══
(function scenario7() {
  const { routerERoot, bridge, RouterVariantE, rpcCalls, insertCalls, redirects, allBodyTexts, dispatchPageshow } = buildScenario({});
  RouterVariantE.init(bridge, routerERoot);
  return driveToRECloseScreen(routerERoot, allBodyTexts).then(() => {
    const nextBtn = findNextButton(routerERoot);
    const backBtn = flatten(routerERoot).find((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('router-back'));
    nextBtn.dispatchClick(); // PATCH now in flight, both buttons disabled
    ok(nextBtn.disabled === true && backBtn.disabled === true, 'Next/Back are disabled immediately after the tap, before the PATCH settles');
    // Simulate the bfcache restore landing WHILE that PATCH is still
    // in flight (its own .then() has not run yet -- dispatchPageshow is
    // called synchronously, no settle() in between).
    dispatchPageshow(true);
    const freshNextBtn = findNextButton(routerERoot);
    const freshBackBtn = flatten(routerERoot).find((c) => c.tagName === 'BUTTON' && c.className.split(' ').includes('router-back'));
    ok(!!freshNextBtn && freshNextBtn.disabled === false, 'the bfcache restore re-renders e-pro-12a with an ENABLED Next button');
    ok(!!freshBackBtn && !freshBackBtn.disabled, 'the bfcache restore re-renders e-pro-12a with an ENABLED Back button');
    freshNextBtn.dispatchClick(); // the actual, post-restore submit
    return settle();
  }).then(() => {
    ok(insertCalls.length === 1, 'only the original email-screen insert ever happened -- the restore + re-tap never inserted a second row');
    const patchCalls = rpcCalls.filter((c) => c.name === 'update_lead_contact');
    ok(patchCalls.length >= 1 && patchCalls.every((c) => c.args.p_lead_id === 'lead-1'),
      'every update_lead_contact call (the original in-flight one, and/or the post-restore one) PATCHes the SAME lead id -- leadId survived the restore');
    ok(redirects.length === 1 && redirects[0].dest.indexOf('lead=lead-1') !== -1, 'the eventual hand-off redirects with that same, original lead id');
  }).catch((e) => { console.error('scenario7 error:', e); fail++; });
})();

setTimeout(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}, 500);
