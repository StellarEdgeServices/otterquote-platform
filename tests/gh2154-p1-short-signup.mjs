/**
 * gh-2154 P-1 -- the short partner signup (name, email, phone,
 * company/brokerage, agreement checkbox; NO password on the signup step;
 * `fbclid`/`li_fat_id`/`funnel_id`/`utm_*` from the URL carried into
 * `register_partner`; D-333 no fee copy for `agent_type=home_inspector`).
 *
 * Written FIRST, per #2121 rule 2 / Ben's bus ruling (2026-09-24T16:25:47Z,
 * #2154): P-1 code is NOT written yet -- this file must FAIL against
 * today's `main` (partner-re.html, partner-insurance.html,
 * partner-inspectors.html), and each failure must be for a P-1 reason:
 *   - today's forms collect a password at signup (P-1 says password is set
 *     AFTER signup) and ask more than the short field set;
 *   - today's forms never read fbclid/li_fat_id/funnel_id from the URL and
 *     never pass them to register_partner (those params exist as of P-2,
 *     PR #2159, but nothing on `main` fills them yet);
 *   - partner-inspectors.html's own meta description still advertises a
 *     dollar fee ("$200 per completed job"), which D-333 prohibits for
 *     home_inspector.
 *
 * Technique: extract the REAL inline <script> source out of each partner
 * page (never a hand-retyped copy) and run it in a `vm` context behind a
 * minimal DOM/Auth/Supabase/CONFIG shim, then drive the real submit
 * handler exactly as a browser would -- same technique as
 * tests/gh2154-p2-app-activation.mjs and tests/gh2107-pixel-gate-optout.mjs.
 * Field-set assertions (a) and (e)/(f) are plain static-HTML checks (no JS
 * execution needed for those).
 *
 * Run: node tests/gh2154-p1-short-signup.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}
function failWithReason(label, reason) {
  console.log('FAIL: ' + label + ' -- ' + reason);
  fail++;
}

// ── Pages under test ───────────────────────────────────────────────────
const PAGES = [
  {
    file: 'partner-re.html',
    label: 'partner-re.html',
    agentType: 're_agent',
    formId: 'partner-form',
    // Best-guess field ids on TODAY's page (used to fill a "complete" form).
    fill: {
      name: { kind: 'first+last', firstId: 'first-name', lastId: 'last-name' },
      emailId: 'email',
      phoneId: 'phone',
      companyId: 'brokerage',
      checkboxId: 'terms',
      passwordIds: ['password', 'confirm-password'],
      // Today's page still client-side-requires these fields even though
      // they are OUTSIDE the P-1 short set; filled only so a "complete
      // submit" can reach register_partner at all and expose the real gap
      // (missing fbclid/li_fat_id/funnel_id), not just get stopped by
      // today's own required-field validation.
      extraRequiredToday: { 'service-area': 'Indianapolis, IN' },
    },
  },
  {
    file: 'partner-insurance.html',
    label: 'partner-insurance.html',
    agentType: 'insurance_agent',
    formId: 'insuranceAgentForm',
    fill: {
      name: { kind: 'full', fullId: 'fullName' },
      emailId: 'email',
      phoneId: 'phone',
      companyId: 'company', // gh-2154 P-1: added by the build worker (see report)
      checkboxId: 'agreeToTerms',
      passwordIds: ['password'],
    },
  },
  {
    file: 'partner-inspectors.html',
    label: 'partner-inspectors.html',
    agentType: 'home_inspector',
    formId: 'partnerForm',
    fill: {
      name: { kind: 'first+last', firstId: 'firstName', lastId: 'lastName' },
      emailId: 'email',
      phoneId: 'phone',
      companyId: 'company',
      checkboxId: 'agreeToTerms',
      passwordIds: ['password', 'confirmPassword'],
    },
  },
];

// The short-field set P-1 specifies: name (single OR first+last), email,
// phone, company/brokerage, agreement checkbox. NOTHING else, and
// definitely no password field on this step.
const SHORT_FIELD_LABEL = 'name (single or first+last) + email + phone + company/brokerage + agreement checkbox, NO password';

// D-266 canonical disclaimer text (verbatim, per js/router-discovery.js
// comment: "126 bytes, Dustin-dictated and final"; found rendered on
// partner-re.html / partner-insurance.html / partner-inspectors.html /
// refer-a-friend.html under class="referral-fee-disclaimer").
const D266_TEXT = 'Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.';

// ── (a)/(e)/(f): static HTML checks (no JS execution) ───────────────────

function extractForm(html) {
  const start = html.indexOf('<form');
  if (start === -1) return null;
  const end = html.indexOf('</form>', start);
  if (end === -1) return null;
  return html.slice(start, end + '</form>'.length);
}

function extractInputs(formHtml) {
  const inputs = [];
  const inputRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(formHtml))) {
    const attrs = m[1];
    const idM = /\bid\s*=\s*"([^"]+)"/i.exec(attrs) || /\bid\s*=\s*'([^']+)'/i.exec(attrs);
    const typeM = /\btype\s*=\s*"([^"]+)"/i.exec(attrs) || /\btype\s*=\s*'([^']+)'/i.exec(attrs);
    inputs.push({ id: idM ? idM[1] : null, type: typeM ? typeM[1].toLowerCase() : 'text' });
  }
  const selectRe = /<select\b([^>]*)>/gi;
  while ((m = selectRe.exec(formHtml))) {
    const attrs = m[1];
    const idM = /\bid\s*=\s*"([^"]+)"/i.exec(attrs) || /\bid\s*=\s*'([^']+)'/i.exec(attrs);
    inputs.push({ id: idM ? idM[1] : null, type: 'select' });
  }
  return inputs;
}

for (const page of PAGES) {
  const html = fs.readFileSync(path.join(repoRoot, page.file), 'utf8');
  const formHtml = extractForm(html);

  // (a) exact short field set, no password.
  if (!formHtml) {
    failWithReason(page.label + ' (a): rendered form has the short field set', 'no <form>...</form> found on the page at all');
  } else {
    const inputs = extractInputs(formHtml);
    const passwordFields = inputs.filter((i) => i.type === 'password');
    const visibleNonPassword = inputs.filter((i) => i.type !== 'password' && i.type !== 'hidden' && i.type !== 'file');
    // Required short-set ids we expect to find, or their absence to report.
    const hasCheckbox = inputs.some((i) => i.type === 'checkbox');
    ok(
      passwordFields.length === 0,
      page.label + ' (a): NO password field on the signup step (' + SHORT_FIELD_LABEL + ') -- found ' + passwordFields.length + ' password input(s): ' + passwordFields.map((f) => f.id).join(', ')
    );
    ok(hasCheckbox, page.label + ' (a): an agreement checkbox is present');
    // "Exactly the short-field set" -- count non-password, non-hidden,
    // non-file, non-checkbox, non-optional-extra visible fields. Today's
    // pages carry extra fields (serviceArea, website, headshot, referredBy,
    // certification, confirmPassword) beyond the short set.
    const shortSetIds = new Set(
      [
        page.fill.name.kind === 'full' ? page.fill.name.fullId : null,
        page.fill.name.kind === 'first+last' ? page.fill.name.firstId : null,
        page.fill.name.kind === 'first+last' ? page.fill.name.lastId : null,
        page.fill.emailId,
        page.fill.phoneId,
        page.fill.companyId,
        page.fill.checkboxId,
      ].filter(Boolean)
    );
    const presentIds = new Set(inputs.map((i) => i.id).filter(Boolean));
    const extras = [...presentIds].filter((id) => !shortSetIds.has(id) && !(page.fill.passwordIds || []).includes(id));
    ok(
      extras.length === 0,
      page.label + ' (a): the form has EXACTLY the short field set (name shape: ' + page.fill.name.kind + '), no extra fields -- extra field ids found: ' + JSON.stringify(extras)
    );
    if (page.fill.companyId) {
      ok(presentIds.has(page.fill.companyId), page.label + ' (a): a company/brokerage field is present');
    } else {
      failWithReason(page.label + ' (a): a company/brokerage field is present', 'page has no company/brokerage input at all (P-1 requires one)');
    }
  }

  // (e) D-333: inspector page carries no fee/dollar copy anywhere rendered,
  // including <meta> description/og/twitter. Realtor/insurance are NOT
  // asserted fee-free -- just recorded.
  const metaTexts = [];
  const metaRe = /<meta\b([^>]*)>/gi;
  let mm;
  while ((mm = metaRe.exec(html))) {
    const attrs = mm[1];
    const nameM = /\b(?:name|property)\s*=\s*"([^"]+)"/i.exec(attrs);
    const contentM = /\bcontent\s*=\s*"([^"]*)"/i.exec(attrs);
    if (nameM && contentM && /description/i.test(nameM[1])) metaTexts.push(contentM[1]);
  }
  const bodyText = html; // whole-file check per the task's wording ("full rendered text, including meta ... and og:/twitter: descriptions")
  const hasDollarAmount = /\$\d/.test(bodyText);
  const hasFeePhrase = /\bper (?:completed )?job\b|\breferral fee\b/i.test(bodyText);
  if (page.agentType === 'home_inspector') {
    ok(!hasDollarAmount, page.label + ' D-333: no "$" amount anywhere in the rendered page (meta/og/twitter included)');
    ok(!hasFeePhrase, page.label + ' D-333: no "per job" / "per completed job" / "referral fee" phrasing anywhere in the rendered page');
    ok(metaTexts.length > 0 && !metaTexts.some((t) => /\$\d/.test(t) || /per (?:completed )?job/i.test(t)), page.label + ' D-333: <meta name="description"> itself carries no fee/dollar copy');
  } else {
    console.log('RECORD (not asserted fee-free): ' + page.label + ' hasDollarAmount=' + hasDollarAmount + ' hasFeePhrase=' + hasFeePhrase + ' meta=' + JSON.stringify(metaTexts));
  }

  // (f) D-266 disclaimer present near the checkbox.
  ok(html.includes(D266_TEXT), page.label + ' (f): the D-266 disclaimer text is present verbatim on the page');
}

// ── (b)/(c)/(d): dynamic checks -- run the REAL page script in a vm ─────

function extractInlineScripts(html) {
  const scripts = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue; // external file, not inline
    if (/type\s*=\s*"application\/ld\+json"/i.test(attrs)) continue; // JSON-LD, not JS
    scripts.push(m[2]);
  }
  return scripts.join('\n;\n');
}

function makeChainable(result) {
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve) => resolve(result || { data: null, error: null });
      if (prop === 'catch' || prop === 'finally') return () => proxy;
      return (..._args) => proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

function makeSb(rpcCalls, registerResult) {
  return {
    rpc(name, params) {
      rpcCalls.push({ name, params });
      if (name === 'register_partner') {
        return Promise.resolve(registerResult || { data: { id: 'gh2154-p1-test-id', unique_code: 'TESTCODE123' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from() { return makeChainable(); },
    storage: {
      from() {
        return {
          upload: () => Promise.resolve({ data: { path: 'x' }, error: null }),
          getPublicUrl: () => ({ data: { publicUrl: null } }),
        };
      },
    },
    auth: { onAuthStateChange() {} },
  };
}

function makeElementStore() {
  const byId = new Map();
  const created = [];
  function makeEl(id, tag) {
    const el = {
      id, tag, value: '', checked: false, disabled: false, files: [],
      textContent: '', innerHTML: '', href: '', className: '', selected: false,
      style: {},
      children: [],
      _listeners: {},
      classList: {
        add() {}, remove() {}, toggle() {}, contains() { return false; },
      },
      addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
      removeEventListener() {},
      appendChild(child) {
        if (child && child.selected && el.tag === 'select') el.value = child.value;
        el.children.push(child);
        return child;
      },
      removeChild() {},
      focus() {},
      click() { (el._listeners.click || []).forEach((fn) => fn({})); },
      scrollIntoView() {},
      querySelector() { return makeEl('__anon__', 'div'); },
      querySelectorAll() { return []; },
      setAttribute() {}, getAttribute() { return null; },
    };
    return el;
  }
  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeEl(id, 'div'));
      return byId.get(id);
    },
    createElement(tag) {
      const el = makeEl('__created_' + created.length, tag);
      created.push(el);
      return el;
    },
    byId,
    created,
  };
}

function runPageScript(page, { search, omitCrypto = false } = {}) {
  const html = fs.readFileSync(path.join(repoRoot, page.file), 'utf8');
  const script = extractInlineScripts(html);
  if (!script || script.indexOf('register_partner') === -1) {
    return { setupError: 'no inline script containing register_partner was found on the page' };
  }
  const store = makeElementStore();
  const rpcCalls = [];
  const sb = makeSb(rpcCalls);
  const lsStore = new Map();
  const localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => { lsStore.set(k, String(v)); },
    removeItem: (k) => { lsStore.delete(k); },
  };

  // gh-2154 P-1 (CSPRNG fix, test (a)/(b)): instrument crypto.getRandomValues
  // and Math.random so the test can assert the signup path uses the former
  // exactly once per submit and never the latter. omitCrypto simulates a
  // browser with no CSPRNG available at all.
  const cryptoCounters = { getRandomValues: 0 };
  const mathCounters = { random: 0 };
  const realMathRandom = Math.random;
  const instrumentedMath = Object.create(Math);
  instrumentedMath.random = function (...args) {
    mathCounters.random++;
    return realMathRandom.apply(Math, args);
  };
  const cryptoStub = omitCrypto ? undefined : {
    getRandomValues(arr) {
      cryptoCounters.getRandomValues++;
      for (let i = 0; i < arr.length; i++) arr[i] = i % 256;
      return arr;
    },
  };
  const domContentLoadedListeners = [];
  const doc = {
    referrer: '',
    getElementById: store.getElementById,
    createElement: store.createElement,
    querySelector(sel) {
      const m = /^#([\w-]+)/.exec(sel || '');
      if (m) return store.getElementById(m[1]);
      return store.createElement('div');
    },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { if (type === 'DOMContentLoaded') domContentLoadedListeners.push(fn); },
    removeEventListener() {},
    body: store.createElement('body'),
  };
  const win = {
    location: { search: search || '', hostname: 'otterquote.com', href: '', replace() {} },
    localStorage,
    addEventListener() {}, removeEventListener() {},
    scrollTo() {},
    requestIdleCallback(fn) { fn(); return 1; },
    crypto: cryptoStub,
  };
  win.window = win;
  const authCounters = { signUpWithPassword: 0 };
  const AuthObj = {
    signUpWithPassword: async () => { authCounters.signUpWithPassword++; return { session: null, user: { id: 'gh2154-p1-test-user-id' } }; },
    hasPartnerSession: async () => false,
    getUser: async () => null,
  };
  win.Auth = AuthObj; // some pages branch on window.Auth explicitly
  const ctx = {
    window: win,
    document: doc,
    localStorage,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    console,
    URLSearchParams,
    Promise, JSON, Date, Math: instrumentedMath, Array, Object, String, Number, Boolean, RegExp,
    Uint8Array, btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
    crypto: cryptoStub,
    setTimeout, clearTimeout, setInterval, clearInterval,
    decodeURIComponent, encodeURIComponent,
    alert() {}, confirm() { return true; },
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
    fbq() {}, gtag() {},
    getOqVariant() { return 'control'; },
    firePartnerSignupComplete() {},
    // Generic no-op stub for any Sentry.* call this page might make --
    // Sentry is unrelated to P-1 signup logic, so every method is a no-op
    // that also accepts (and ignores) a callback argument, covering
    // patterns like Sentry.onLoad(cb) / Sentry.withScope(cb).
    Sentry: new Proxy({}, {
      get: () => (...args) => { const cb = args.find((a) => typeof a === 'function'); if (cb) cb({ setTag() {}, setContext() {}, setLevel() {}, setUser() {} }); },
    }),
    sb,
    Auth: AuthObj,
    CONFIG: {
      whenReady(cb) { cb(sb); },
      SUPPORT_EMAIL: 'support@otterquote.com',
      SITE_URL: 'https://otterquote.com',
      DEMO_MODE: false,
    },
    AgentTypes: {
      CHOOSER_LABELS: {
        re_agent: 'Real Estate Agent',
        insurance_agent: 'Insurance Agent',
        home_inspector: 'Home Inspector',
        adjuster: 'Adjuster',
        other: 'Other',
      },
    },
  };
  vm.createContext(ctx);
  try {
    vm.runInContext(script, ctx, { timeout: 5000 });
  } catch (e) {
    return { setupError: 'script execution error while loading the page: ' + e.message };
  }
  // Fire DOMContentLoaded for pages that wire their submit listener there
  // (e.g. partner-inspectors.html).
  for (const fn of domContentLoadedListeners) {
    try { fn(); } catch (e) { /* ignore, surfaced via missing submit listener below */ }
  }
  return { store, rpcCalls, ctx, cryptoCounters, mathCounters, authCounters, lsStore };
}

async function submitForm(runResult, formId, fill) {
  const el = runResult.store.byId.get(formId);
  if (!el) throw new Error('no element with id #' + formId + ' was ever referenced by the page script (document.getElementById was never called with that id)');
  // Fill fields.
  for (const [id, val] of Object.entries(fill)) {
    const fieldEl = runResult.store.getElementById(id);
    if (typeof val === 'boolean') fieldEl.checked = val;
    else fieldEl.value = val;
  }
  const listeners = el._listeners.submit;
  if (!listeners || !listeners.length) {
    throw new Error('no submit listener was ever registered on #' + formId);
  }
  const fakeEvent = { preventDefault() {} };
  const results = listeners.map((fn) => fn(fakeEvent));
  // Synchronously (Promise executors run sync), the confirmAgentType()
  // modal has now been created if the page reached that line. Click its
  // "Confirm & Continue" button so the pending promise resolves and the
  // handler can proceed to register_partner.
  const confirmBtn = runResult.store.created
    .slice()
    .reverse()
    .find((e) => e.textContent === 'Confirm & Continue');
  if (confirmBtn) confirmBtn.click();
  await Promise.all(results);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function fullFill(page, overrides = {}) {
  const fill = {};
  if (page.fill.name.kind === 'full') fill[page.fill.name.fullId] = 'Jane Test';
  else { fill[page.fill.name.firstId] = 'Jane'; fill[page.fill.name.lastId] = 'Test'; }
  fill[page.fill.emailId] = 'gh2154-p1-test@example.invalid';
  fill[page.fill.phoneId] = '3175551234';
  if (page.fill.companyId) fill[page.fill.companyId] = 'Test Co';
  for (const pwId of page.fill.passwordIds || []) fill[pwId] = 'TestPassw0rd!';
  Object.assign(fill, page.fill.extraRequiredToday || {});
  fill[page.fill.checkboxId] = true;
  return { ...fill, ...overrides };
}

const QS = '?funnel_id=re-1&fbclid=TESTFBCLID&li_fat_id=TESTLI&utm_campaign=re-1&utm_source=facebook';

for (const page of PAGES) {
  // (c) NEGATIVE CONTROL: load, never submit -> zero register_partner calls.
  {
    const run = runPageScript(page, { search: QS });
    if (run.setupError) {
      failWithReason(page.label + ' (c) NEGATIVE CONTROL: loading without submitting makes zero register_partner calls', run.setupError);
    } else {
      const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
      ok(calls.length === 0, page.label + ' (c) NEGATIVE CONTROL: loading the page and not submitting makes zero register_partner calls');
    }
  }

  // (b) full submit with funnel/fbclid/li_fat_id/utm carried through.
  {
    const run = runPageScript(page, { search: QS });
    if (run.setupError) {
      failWithReason(page.label + ' (b): submitting calls register_partner with p_funnel_id/p_fbclid/p_li_fat_id/p_utm_campaign/p_agent_type', run.setupError);
    } else {
      try {
        await submitForm(run, page.formId, fullFill(page));
        const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
        ok(calls.length === 1, page.label + ' (b): register_partner is called exactly once on a filled, agreed-to submit -- got ' + calls.length + ' call(s)');
        const params = calls[0] ? calls[0].params || {} : {};
        ok(params.p_funnel_id === 're-1', page.label + ' (b): p_funnel_id="re-1" is passed -- got ' + JSON.stringify(params.p_funnel_id));
        ok(params.p_fbclid === 'TESTFBCLID', page.label + ' (b): p_fbclid="TESTFBCLID" is passed -- got ' + JSON.stringify(params.p_fbclid));
        ok(params.p_li_fat_id === 'TESTLI', page.label + ' (b): p_li_fat_id="TESTLI" is passed -- got ' + JSON.stringify(params.p_li_fat_id));
        ok(params.p_utm_campaign === 're-1', page.label + ' (b): p_utm_campaign="re-1" is passed -- got ' + JSON.stringify(params.p_utm_campaign));
        ok(params.p_agent_type === page.agentType, page.label + ' (b): p_agent_type="' + page.agentType + '" is passed -- got ' + JSON.stringify(params.p_agent_type));
      } catch (e) {
        failWithReason(page.label + ' (b): submitting calls register_partner with p_funnel_id/p_fbclid/p_li_fat_id/p_utm_campaign/p_agent_type', e.message);
      }
    }
  }

  // (d) NEGATIVE CONTROL: submit without the agreement box ticked -> zero calls.
  {
    const run = runPageScript(page, { search: QS });
    if (run.setupError) {
      failWithReason(page.label + ' (d) NEGATIVE CONTROL: submitting without the agreement checkbox makes zero register_partner calls', run.setupError);
    } else {
      try {
        await submitForm(run, page.formId, fullFill(page, { [page.fill.checkboxId]: false }));
        const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
        ok(calls.length === 0, page.label + ' (d) NEGATIVE CONTROL: submitting without the agreement checkbox ticked makes zero register_partner calls -- got ' + calls.length + ' call(s)');
      } catch (e) {
        // A thrown error here (e.g. no submit listener at all) is itself a
        // legitimate reason the negative control can't be exercised -- but
        // if the listener exists and just never called register_partner
        // (because it validated and returned early), that isn't an
        // exception, it's zero calls, which is exactly the passing shape.
        // Only report FAIL if we truly could not drive the page at all.
        failWithReason(page.label + ' (d) NEGATIVE CONTROL: submitting without the agreement checkbox makes zero register_partner calls', e.message);
      }
    }
  }

  // (g) gh-2154 P-1 CSPRNG fix: the signup path calls crypto.getRandomValues
  // exactly once per submit and never Math.random.
  {
    const run = runPageScript(page, { search: QS });
    if (run.setupError) {
      failWithReason(page.label + ' (g): crypto.getRandomValues called exactly once per submit, never Math.random', run.setupError);
    } else {
      try {
        await submitForm(run, page.formId, fullFill(page));
        ok(run.cryptoCounters.getRandomValues === 1, page.label + ' (g): crypto.getRandomValues() called exactly once on submit -- got ' + run.cryptoCounters.getRandomValues);
        ok(run.mathCounters.random === 0, page.label + ' (g): Math.random() is never called in the signup path -- got ' + run.mathCounters.random + ' call(s)');
      } catch (e) {
        failWithReason(page.label + ' (g): crypto.getRandomValues called exactly once per submit, never Math.random', e.message);
      }
    }
  }

  // (h) NEGATIVE CONTROL: no CSPRNG available -> the page refuses to sign up
  // (zero Auth.signUpWithPassword calls, zero register_partner calls) and
  // never falls back to Math.random.
  {
    const run = runPageScript(page, { search: QS, omitCrypto: true });
    if (run.setupError) {
      failWithReason(page.label + ' (h) NEGATIVE CONTROL: no crypto.getRandomValues -> zero signUp / register_partner calls', run.setupError);
    } else {
      try {
        await submitForm(run, page.formId, fullFill(page));
        const registerCalls = run.rpcCalls.filter((c) => c.name === 'register_partner');
        ok(registerCalls.length === 0, page.label + ' (h) NEGATIVE CONTROL: no crypto.getRandomValues -> zero register_partner calls -- got ' + registerCalls.length);
        ok(run.authCounters.signUpWithPassword === 0, page.label + ' (h) NEGATIVE CONTROL: no crypto.getRandomValues -> zero Auth.signUpWithPassword calls -- got ' + run.authCounters.signUpWithPassword);
        ok(run.mathCounters.random === 0, page.label + ' (h) NEGATIVE CONTROL: no crypto.getRandomValues -> never falls back to Math.random -- got ' + run.mathCounters.random + ' call(s)');
      } catch (e) {
        failWithReason(page.label + ' (h) NEGATIVE CONTROL: no crypto.getRandomValues -> zero signUp / register_partner calls', e.message);
      }
    }
  }

  // (i) gh-2154 P-1: a successful signup sets the
  // 'oq_partner_needs_password:<uid>' localStorage flag for the created user.
  {
    const run = runPageScript(page, { search: QS });
    if (run.setupError) {
      failWithReason(page.label + ' (i): a successful signup sets oq_partner_needs_password:<uid>', run.setupError);
    } else {
      try {
        await submitForm(run, page.formId, fullFill(page));
        const flagValue = run.lsStore.get('oq_partner_needs_password:gh2154-p1-test-user-id');
        ok(flagValue === '1', page.label + ' (i): oq_partner_needs_password:<uid> is set to "1" after a successful signup -- got ' + JSON.stringify(flagValue));
      } catch (e) {
        failWithReason(page.label + ' (i): a successful signup sets oq_partner_needs_password:<uid>', e.message);
      }
    }
  }
}

console.log('');
console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
