/**
 * gh-2274 -- partner signup surfaces a raw exception string on a
 * duplicate-email registration (INS-1, and by inspection every partner
 * signup page sharing the same two-step register_partner-RPC-then-
 * Auth.signUpWithPassword() pattern).
 *
 * Root cause (see PR body for full writeup): each page already special-
 * cases ONE duplicate check -- the register_partner RPC's own
 * 'partner_exists' error, raised when a referral_agents row already
 * exists for that email. But signup is two separate existence checks
 * against two separate tables: the RPC's referral_agents check, and the
 * subsequent Auth.signUpWithPassword() call's auth.users check. An email
 * can already have an auth.users row (e.g. a previous signup attempt that
 * got this far before failing, or the same email registered under a
 * different partner type) with no referral_agents row yet -- so the RPC
 * succeeds, and it's Auth.signUpWithPassword() that then rejects with
 * Supabase's own literal "User already registered", uncaught, straight
 * into whichever generic catch each page had (some of which concatenated
 * the raw error.message into the text shown to the user).
 *
 * Asserts, for every partner signup page in scope:
 *   (a) a "User already registered" error from Auth.signUpWithPassword()
 *       (thrown AFTER the register_partner RPC already succeeded) surfaces
 *       the page's OWN pre-existing designed already-a-partner message --
 *       the exact string/markup it already uses for the RPC's
 *       'partner_exists' branch -- not a raw exception string.
 *   (b) NEGATIVE CONTROL / static: no page's source concatenates
 *       error.message / err.message into a showFormAlert(...)/alert(...)
 *       call anywhere (the leak this issue is about).
 *
 * Technique: same as tests/gh2151-ins1-page.mjs / tests/gh2154-p1-short-
 * signup.mjs -- extract the REAL inline <script> source and run it in a
 * `vm` context behind a minimal DOM/Auth/Supabase/CONFIG shim, then drive
 * the real submit handler exactly as a browser would.
 *
 * Run: node tests/gh2274-partner-dup-email-error.mjs
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

// ── (b) static, all-pages: no error.message/err.message leak into a
// user-facing alert. This is the literal shape of the bug in the issue
// ("An error occurred ... : User already registered"). Checked over every
// partner signup page that exists, not just the ones changed here, so this
// also acts as a regression guard against a NEW leak being introduced on a
// page nobody touched for gh-2274.
const ALL_PARTNER_PAGES = [
  'hi-1.html', 'hi-4.html', 'hi-5.html',
  'ins-1.html', 'ins-3.html', 'ins-5.html', 'partner-insurance.html',
  're-1.html', 're-3.html', 're-5.html', 'partner-re.html',
  'partner-adjusters.html', 'partner-inspectors.html', 'partner-other.html',
];
const LEAK_PATTERNS = [
  /showFormAlert\([^)]*error\.message/,
  /showFormAlert\([^)]*err\.message/,
  /\balert\([^)]*error\.message/,
  /\balert\([^)]*err\.message/,
  /\balert\(`[^`]*\$\{\s*err\.message\s*\}/,
  /\balert\(`[^`]*\$\{\s*error\.message\s*\}/,
];
for (const file of ALL_PARTNER_PAGES) {
  const html = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const leaked = LEAK_PATTERNS.some((re) => re.test(html));
  ok(!leaked, file + ' (b): no showFormAlert/alert call concatenates the raw error.message/err.message');
}

// ── (a) dynamic, per-page: a duplicate-email auth error routes to the
// page's own pre-existing designed message ─────────────────────────────

function extractInlineScripts(h) {
  const scripts = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let mm;
  while ((mm = re.exec(h))) {
    const attrs = mm[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/type\s*=\s*"application\/ld\+json"/i.test(attrs)) continue;
    scripts.push(mm[2]);
  }
  return scripts.join('\n;\n');
}

function makeElementStore() {
  const byId = new Map();
  const created = [];
  function makeEl(id, tag) {
    const classes = new Set();
    const el = {
      id, tag, value: '', checked: false, disabled: false, files: [],
      textContent: '', innerHTML: '', href: '', className: '', selected: false,
      style: {}, children: [], _listeners: {}, _attrs: {},
      classList: {
        add(...names) { names.forEach((n) => classes.add(n)); },
        remove(...names) { names.forEach((n) => classes.delete(n)); },
        toggle() {},
        contains(n) { return classes.has(n); },
      },
      addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
      removeEventListener() {},
      appendChild(child) {
        if (child && child.selected && el.tag === 'select') el.value = child.value;
        el.children.push(child);
        return child;
      },
      removeChild() {},
      focus() { (el._listeners.focus || []).forEach((fn) => fn({})); },
      click() { (el._listeners.click || []).forEach((fn) => fn({})); },
      scrollIntoView() {},
      load() {}, play() { return Promise.resolve(); }, pause() {},
      querySelector() { return makeEl('__anon__', 'div'); },
      querySelectorAll() { return []; },
      setAttribute(k, v) { el._attrs[k] = v; }, getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
      removeAttribute(k) { delete el._attrs[k]; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k); },
    };
    return el;
  }
  return {
    getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl(id, 'div')); return byId.get(id); },
    createElement(tag) { const el = makeEl('__created_' + created.length, tag); created.push(el); return el; },
    byId, created,
  };
}

// Runs a page's real inline script(s) in a vm context. register_partner
// SUCCEEDS unless rpcError is given (this simulates the RPC-level duplicate
// check not catching it -- e.g. no referral_agents row yet for this email/type).
// Auth.signUpWithPassword() REJECTS with Supabase's own literal duplicate-
// registration message -- this is the auth.users-level duplicate the RPC
// above cannot see.
function runPageScript(html, { search = '', signUp = 'dup', dupError = null, rpcError = null } = {}) {
  const script = extractInlineScripts(html);
  if (!script || script.indexOf('register_partner') === -1) {
    return { setupError: 'no inline script containing register_partner was found on the page' };
  }
  const store = makeElementStore();
  const rpcCalls = [];
  const callOrder = [];
  const alertCalls = [];
  // gh2274 fix-up: a plain always-Promise-returning Proxy trap (the prior
  // shape here) breaks the moment a caller does something other than a
  // single terminal method call -- e.g. partner-re.html builds the query
  // (`sb.from('leads').insert({...})`), calls a non-terminal chained method
  // on the *result* (`leadInsert.setHeader(...)`), and only then awaits the
  // original reference. Accessing `.then` off the old Proxy returned a
  // function that ignored the resolve/reject callbacks it was given, so the
  // await never settled. This chainable object is itself thenable (real
  // .then/.catch/.finally that settle) AND every other property access
  // returns a function that yields that same object back, so any chain
  // depth or extra non-terminal calls (setHeader, select, single, ...)
  // stay awaitable no matter where the `await` lands.
  function makeChainable(result) {
    const proxy = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
        if (prop === 'catch') return (reject) => Promise.resolve(result).catch(reject);
        if (prop === 'finally') return (fn) => Promise.resolve(result).finally(fn);
        return () => proxy;
      },
    });
    return proxy;
  }
  const sb = {
    rpc(name, params) {
      rpcCalls.push({ name, params });
      if (name === 'register_partner') {
        callOrder.push('register_partner');
        if (rpcError) return Promise.resolve({ data: null, error: rpcError });
        return Promise.resolve({ data: { id: 'gh2274-test-id', unique_code: 'TESTCODE123' }, error: null });
      }
      if (name === 'claim_partner_account') {
        return Promise.resolve({ data: { claimed: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from() { return makeChainable({ data: null, error: null }); },
    storage: { from() { return { upload: () => Promise.resolve({ data: { path: 'x' }, error: null }), getPublicUrl: () => ({ data: { publicUrl: null } }) }; } },
    auth: { onAuthStateChange() {}, updateUser() { return Promise.resolve({ data: {}, error: null }); } },
  };
  const lsStore = new Map();
  const localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => { lsStore.set(k, String(v)); },
    removeItem: (k) => { lsStore.delete(k); },
  };
  const cryptoStub = { getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = i % 256; return arr; } };
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
    supabase: {},
  };
  win.window = win;
  // The bug: Auth.signUpWithPassword() throws Supabase's own literal
  // duplicate-registration error -- always AFTER register_partner has
  // already succeeded above, exactly the ordering every page uses.
  const AuthObj = {
    signUpWithPassword: async () => {
      callOrder.push('signUp');
      if (signUp === 'ok') return { user: { id: 'gh2274-user-id' }, session: null };
      throw (dupError || new Error('User already registered'));
    },
    hasPartnerSession: async () => false,
    getUser: async () => null,
    isTestEmail: (email) => (email || '').trim().toLowerCase().endsWith('@otterquote-internal.test'),
  };
  win.Auth = AuthObj;
  const ctx = {
    window: win, document: doc, localStorage,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    console, URLSearchParams,
    Promise, JSON, Date, Math, Array, Object, String, Number, Boolean, RegExp,
    Uint8Array, btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
    crypto: cryptoStub,
    setTimeout, clearTimeout, setInterval, clearInterval,
    decodeURIComponent, encodeURIComponent,
    alert(msg) { alertCalls.push(String(msg)); }, confirm() { return true; },
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
    fbq() {}, gtag() {},
    Sentry: new Proxy({}, { get: () => (...args) => { const cb = args.find((a) => typeof a === 'function'); if (cb) cb({ setTag() {}, setContext() {}, setLevel() {}, setUser() {} }); } }),
    sb, Auth: AuthObj,
    CONFIG: { whenReady(cb) { cb(sb); }, SUPPORT_EMAIL: 'support@otterquote.com', SITE_URL: 'https://otterquote.com', DEMO_MODE: false },
    AgentTypes: { CHOOSER_LABELS: { re_agent: 'Real Estate Agent', insurance_agent: 'Insurance Agent', home_inspector: 'Home Inspector', adjuster: 'Adjuster', other: 'Other' } },
  };
  vm.createContext(ctx);
  try {
    vm.runInContext(script, ctx, { timeout: 5000 });
  } catch (e) {
    return { setupError: 'script execution error while loading the page: ' + e.message };
  }
  for (const fn of domContentLoadedListeners) { try { fn(); } catch (e) {} }
  return { store, rpcCalls, alertCalls, callOrder };
}

async function submitForm(runResult, formId, fill, { hasConfirmPopup = false } = {}) {
  const el = runResult.store.byId.get(formId);
  if (!el) throw new Error('no element with id #' + formId + ' was ever referenced by the page script');
  for (const [id, val] of Object.entries(fill)) {
    const fieldEl = runResult.store.getElementById(id);
    if (typeof val === 'boolean') fieldEl.checked = val;
    else fieldEl.value = val;
  }
  const listeners = el._listeners.submit;
  if (!listeners || !listeners.length) throw new Error('no submit listener was ever registered on #' + formId);
  const fakeEvent = { preventDefault() {} };
  const results = listeners.map((fn) => fn(fakeEvent));
  if (hasConfirmPopup) {
    // gh-865 "Confirm your partner type" modal -- await its own microtask
    // tick so the modal DOM exists, then click through it.
    await new Promise((r) => setTimeout(r, 0));
    const confirmBtn = runResult.store.created.slice().reverse().find((e) => e.textContent === 'Confirm & Continue');
    if (confirmBtn) confirmBtn.click();
  }
  await Promise.all(results);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const PAGES = [
  {
    file: 'hi-1.html', formId: 'homeInspectorForm',
    fields: { fullName: 'Jane Test', email: 'gh2274-dup@example.invalid', phone: '3175551234', company: 'Test Co', agreeToTerms: true },
    surface: 'formAlert', designed: "You're already a partner — sign in at the Partner Login page.",
  },
  {
    file: 'hi-4.html', formId: 'homeInspectorForm',
    fields: { fullName: 'Jane Test', email: 'gh2274-dup@example.invalid', phone: '3175551234', company: 'Test Co', agreeToTerms: true },
    surface: 'formAlert', designed: "You're already a partner — sign in at the Partner Login page.",
  },
  {
    file: 'hi-5.html', formId: 'homeInspectorForm',
    fields: { fullName: 'Jane Test', email: 'gh2274-dup@example.invalid', phone: '3175551234', company: 'Test Co', agreeToTerms: true },
    surface: 'formAlert', designed: "You're already a partner — sign in at the Partner Login page.",
  },
  {
    file: 'ins-1.html', formId: 'insuranceAgentForm',
    fields: { fullName: 'Jane Test', email: 'gh2274-dup@example.invalid', phone: '3175551234', company: 'Test Agency', agreeToTerms: true },
    surface: 'formAlert', designed: "You're already a partner — sign in at the Partner Login page.",
  },
  {
    file: 'ins-3.html', formId: 'insuranceAgentForm',
    fields: { fullName: 'Jane Test', email: 'gh2274-dup@example.invalid', phone: '3175551234', company: 'Test Agency', agreeToTerms: true },
    surface: 'formAlert', designed: "You're already a partner — sign in at the Partner Login page.",
  },
  {
    file: 'ins-5.html', formId: 'insuranceAgentForm',
    fields: { fullName: 'Jane Test', email: 'gh2274-dup@example.invalid', phone: '3175551234', company: 'Test Agency', agreeToTerms: true },
    surface: 'formAlert', designed: "You're already a partner — sign in at the Partner Login page.",
  },
  {
    file: 'partner-insurance.html', formId: 'insuranceAgentForm', hasConfirmPopup: true,
    fields: { fullName: 'Jane Test', email: 'gh2274-dup@example.invalid', phone: '3175551234', company: 'Test Agency', agreeToTerms: true },
    surface: 'formAlert', designed: "You're already a partner — sign in at the Partner Login page.",
  },
  {
    file: 're-1.html', formId: 'partner-form',
    fields: { name: 'Jane Test', email: 'gh2274-dup@example.invalid', phone: '3175551234', brokerage: 'Test Realty', terms: true },
    surface: 'errorEl', errorElId: 'form-error',
    designed: "You're already a partner — <a href=\"/partner-login.html\">sign in here</a>.",
  },
  {
    file: 're-3.html', formId: 'partner-form',
    fields: { name: 'Jane Test', email: 'gh2274-dup@example.invalid', phone: '3175551234', brokerage: 'Test Realty', terms: true },
    surface: 'errorEl', errorElId: 'form-error',
    designed: "You're already a partner — <a href=\"/partner-login.html\">sign in here</a>.",
  },
  {
    file: 're-5.html', formId: 'partner-form',
    fields: { name: 'Jane Test', email: 'gh2274-dup@example.invalid', phone: '3175551234', brokerage: 'Test Realty', terms: true },
    surface: 'errorEl', errorElId: 'form-error',
    designed: "You're already a partner — <a href=\"/partner-login.html\">sign in here</a>.",
  },
  {
    file: 'partner-re.html', formId: 'partner-form', hasConfirmPopup: true,
    fields: { 'first-name': 'Jane', 'last-name': 'Test', email: 'gh2274-dup@example.invalid', phone: '3175551234', brokerage: 'Test Realty', terms: true },
    surface: 'errorEl', errorElId: 'form-error',
    designed: "You're already a partner — <a href=\"/partner-login.html\">sign in here</a>.",
  },
  {
    file: 'partner-adjusters.html', formId: 'partnerForm', hasConfirmPopup: true,
    fields: {
      firstName: 'Jane', lastName: 'Test', email: 'gh2274-dup@example.invalid',
      password: 'TestPass1234', confirmPassword: 'TestPass1234', phone: '3175551234',
      employer: 'Test Employer', adjusterType: 'staff', referredBy: '', agreeToTerms: true,
    },
    surface: 'alert', designed: "You're already a partner — sign in at otterquote.com/partner-login.html.",
  },
  {
    file: 'partner-inspectors.html', formId: 'partnerForm', hasConfirmPopup: true,
    fields: {
      firstName: 'Jane', lastName: 'Test', email: 'gh2274-dup@example.invalid',
      phone: '3175551234', company: 'Test Co', agreeToTerms: true,
    },
    surface: 'alert', designed: "You're already a partner — sign in at otterquote.com/partner-login.html.",
  },
  {
    file: 'partner-other.html', formId: 'partnerForm', hasConfirmPopup: true,
    fields: {
      firstName: 'Jane', lastName: 'Test', email: 'gh2274-dup@example.invalid',
      password: 'TestPass1234', confirmPassword: 'TestPass1234', phone: '3175551234',
      industry: 'Landscaping', company: 'Test Co', referredBy: '', agreeToTerms: true,
    },
    surface: 'alert', designed: "You're already a partner — sign in at otterquote.com/partner-login.html.",
  },
];

// gh-2281: (a) = English message text only (older SDKs, no .code);
// (c) = Supabase's structured error.code with a LOCALIZED/reworded message
// that contains no "already registered" text -- the case a message-only
// match silently drops through to the generic catch-all.
const VARIANTS = [
  { tag: '(a)', dupError: null },
  { tag: '(c)', dupError: Object.assign(new Error('Ce compte existe deja'), { code: 'user_already_exists' }) },
];
for (const page of PAGES) {
  for (const variant of VARIANTS) {
  const label = page.file + ' ' + variant.tag;
  const htmlPath = path.join(repoRoot, page.file);
  if (!fs.existsSync(htmlPath)) {
    failWithReason(label + ': a duplicate-email auth error routes to the designed already-a-partner state', 'file not found: ' + page.file);
    continue;
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const run = runPageScript(html, { dupError: variant.dupError });
  if (run.setupError) {
    failWithReason(label + ': a duplicate-email auth error routes to the designed already-a-partner state', run.setupError);
    continue;
  }
  try {
    await submitForm(run, page.formId, page.fields, { hasConfirmPopup: !!page.hasConfirmPopup });

    // register_partner must have been called and (per this test's mock)
    // succeeded -- confirming Auth.signUpWithPassword() is genuinely what
    // raised the duplicate error, same ordering as the real pages.
    // gh-2282: the auth-level duplicate is now hit FIRST, so register_partner
    // must never run -- otherwise it leaves an orphaned referral_agents row.
    const rpcCalls = run.rpcCalls.filter((c) => c.name === 'register_partner');
    ok(rpcCalls.length === 0, label + ': register_partner is NOT called when the email already has an auth account (no orphan referral_agents row) -- got ' + rpcCalls.length + ' call(s)');

    let surfaced = '';
    if (page.surface === 'formAlert') {
      surfaced = run.store.byId.get('formAlert') ? run.store.byId.get('formAlert').textContent : '';
    } else if (page.surface === 'errorEl') {
      const el = run.store.byId.get(page.errorElId);
      surfaced = el ? (el.innerHTML || el.textContent) : '';
    } else if (page.surface === 'alert') {
      surfaced = run.alertCalls.join(' | ');
    }

    ok(!/User already registered/.test(surfaced), label + ': the raw Supabase "User already registered" string is NOT shown to the user -- got ' + JSON.stringify(surfaced));
    ok(surfaced.includes(page.designed), label + ': the pre-existing designed already-a-partner message is shown verbatim -- got ' + JSON.stringify(surfaced));
  } catch (e) {
    failWithReason(label + ': a duplicate-email auth error routes to the designed already-a-partner state', e.message + (e.stack ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : ''));
  }
  }
}

// gh-2282 (d)/(e): success path and the RPC-level duplicate, both now AFTER
// a successful Auth.signUpWithPassword().
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(repoRoot, page.file), 'utf8');
  // (d) new email: signUp first, then register_partner exactly once.
  let run = runPageScript(html, { signUp: 'ok' });
  if (run.setupError) { failWithReason(page.file + ' (d)', run.setupError); continue; }
  try {
    await submitForm(run, page.formId, page.fields, { hasConfirmPopup: !!page.hasConfirmPopup });
    ok(run.callOrder.join(',') === 'signUp,register_partner', page.file + ' (d): new email -- Auth.signUpWithPassword runs BEFORE register_partner, which runs exactly once -- got ' + JSON.stringify(run.callOrder));
  } catch (e) { failWithReason(page.file + ' (d)', e.message); }
  // (e) register_partner says partner_exists after signUp succeeded: the designed message still shows.
  run = runPageScript(html, { signUp: 'ok', rpcError: { message: 'partner_exists' } });
  if (run.setupError) { failWithReason(page.file + ' (e)', run.setupError); continue; }
  try {
    await submitForm(run, page.formId, page.fields, { hasConfirmPopup: !!page.hasConfirmPopup });
    let surfaced = '';
    if (page.surface === 'formAlert') surfaced = run.store.byId.get('formAlert') ? run.store.byId.get('formAlert').textContent : '';
    else if (page.surface === 'errorEl') { const el = run.store.byId.get(page.errorElId); surfaced = el ? (el.innerHTML || el.textContent) : ''; }
    else surfaced = run.alertCalls.join(' | ');
    ok(surfaced.includes(page.designed), page.file + ' (e): RPC partner_exists still shows the designed already-a-partner message -- got ' + JSON.stringify(surfaced));
  } catch (e) { failWithReason(page.file + ' (e)', e.message); }
}

// gh-2281 static guard: every page consults the structured error.code.
for (const file of ALL_PARTNER_PAGES) {
  const html = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  ok(/signUpError\s*&&\s*signUpError\.code\s*===\s*'user_already_exists'/.test(html), file + ' (c): checks signUpError.code === \'user_already_exists\'');
  ok(/toLowerCase\(\)\.includes\('already registered'\)/.test(html), file + ' (c): keeps the message-text fallback');
}

console.log('');
console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
