/**
 * gh-2084 -- one `leads` row per partner signup, variant carried (arm E).
 *
 * Root cause: start.html's router inserts the visitor's leads row (variant
 * 'e', source 'router') and hands it to partner-re.html as ?lead=<uuid>
 * (read by the page's first <head> script into window.__oqRouterLeadId).
 * partner-re.html's submit handler then ALWAYS ran its own
 * sb.from('leads').insert({... source:'re_agent'}) with no variant, so one
 * signup wrote two rows (CTO57 walk, comment 5965011723). partner-insurance
 * .html never touches `leads` (asserted below), so it was not affected.
 *
 * Asserts on the REAL inline script of partner-re.html, run in a vm behind
 * a DOM/Auth/Supabase shim that records every sb.from(...) call:
 *   (a) with a router lead id present: ZERO leads insert/upsert/update calls
 *       and no RPC that writes leads (the router row already carries the
 *       variant: leads.variant is write-once, set by the router's insert);
 *       register_partner still runs.
 *   (b) without a lead id, variant in ?v=e: EXACTLY ONE leads insert, and
 *       it carries variant 'e'.
 *   (c) without a lead id and no variant known: exactly one insert, and no
 *       variant key is sent (never a bogus 'unknown').
 *   (d) static: partner-insurance.html has no leads write at all.
 *   (e)-(h) REVIEW FAIL fix: the insert is skipped only when get_lead_prefill
 *       CONFIRMED the router row (window.__oqRouterLeadConfirmed). The page's
 *       real head script sets __oqRouterLeadId from ?lead= (not injected).
 *       Garbage id / unknown uuid with no prefill row: 1 insert (x-oq-internal
 *       kept). Submit before prefill resolves: the handler waits; row -> 0
 *       inserts, no row -> 1 insert.
 * Negative control: on origin/main (a) fails (a second insert is made) and
 * (b) fails (variant missing).
 *
 * Run: node tests/gh2084-partner-re-one-lead-row.mjs
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
function runPageScript(html, { search = '', leadId = null, signUp = 'ok', dupError = null, rpcError = null, signUpSeq = null, rpcSeq = null, sessionEmail = null, ls = null, ss = null, prefill = 'none', deferPrefill = false } = {}) {
  const script = extractInlineScripts(html);
  if (!script || script.indexOf('register_partner') === -1) {
    return { setupError: 'no inline script containing register_partner was found on the page' };
  }
  const store = makeElementStore();
  const rpcCalls = [];
  const leadsCalls = [];
  const callOrder = [];
  let signUpN = 0, rpcN = 0;
  const alertCalls = [];
  const prefillResolvers = [];
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
        const rpcErr = rpcSeq ? rpcSeq[Math.min(rpcN++, rpcSeq.length - 1)] : rpcError;
        if (rpcErr) return Promise.resolve({ data: null, error: rpcErr });
        return Promise.resolve({ data: { id: 'gh2274-test-id', unique_code: 'TESTCODE123' }, error: null });
      }
      if (name === 'get_lead_prefill') {
        // gh-2084 fix: the real prefill script calls this. 'row' = a live router
        // row, 'none' = expired/unknown/garbage id (RPC returns no rows).
        const result = { data: prefill === 'row' ? [{ name: 'Jane Test', email: 'router@example.com', phone: '3175550000' }] : [], error: null };
        if (deferPrefill) return new Promise((resolve) => { prefillResolvers.push((rowOrNull) => resolve({ data: rowOrNull ? [rowOrNull] : [], error: null })); });
        return Promise.resolve(result);
      }
      if (name === 'claim_partner_account') {
        return Promise.resolve({ data: { claimed: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table) {
      const rec = { table, op: null, payload: null, headers: {} };
      leadsCalls.push(rec);
      const proxy = new Proxy(function () {}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject);
          if (prop === 'catch') return (reject) => Promise.resolve({ data: null, error: null }).catch(reject);
          if (prop === 'finally') return (fn) => Promise.resolve({ data: null, error: null }).finally(fn);
          if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') {
            return (payload) => { rec.op = prop; rec.payload = payload; return proxy; };
          }
          if (prop === 'setHeader') return (k, v) => { rec.headers[k] = v; return proxy; };
          return () => proxy;
        },
      });
      return proxy;
    },
    storage: { from() { return { upload: () => Promise.resolve({ data: { path: 'x' }, error: null }), getPublicUrl: () => ({ data: { publicUrl: null } }) }; } },
    auth: { onAuthStateChange() {}, updateUser() { return Promise.resolve({ data: {}, error: null }); } },
  };
  const lsStore = new Map();
  if (ls) for (const [k, v] of Object.entries(ls)) lsStore.set(k, v);
  // gh-2355: the pending-registration marker (name/phone/company) lives in sessionStorage, never localStorage.
  const ssStore = new Map();
  if (ss) for (const [k, v] of Object.entries(ss)) ssStore.set(k, v);
  const sessionStorage = {
    getItem: (k) => (ssStore.has(k) ? ssStore.get(k) : null),
    setItem: (k, v) => { ssStore.set(k, String(v)); },
    removeItem: (k) => { ssStore.delete(k); },
  };
  const localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => { lsStore.set(k, String(v)); },
    removeItem: (k) => { lsStore.delete(k); },
  };
  const cryptoStub = { getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = i % 256; return arr; } };
  const domContentLoadedListeners = [];
  const doc = {
    referrer: '', cookie: '',
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
    // gh-2084 fix: __oqRouterLeadId is NOT injected; the page's real first <head>
    // script sets it from ?lead= in location.search.
    history: { state: null, replaceState() {} },
    sb,
    location: { search: search || '', hostname: 'otterquote.com', href: '', replace() {} },
    localStorage, sessionStorage,
    addEventListener() {}, removeEventListener() {},
    scrollTo() {},
    requestIdleCallback(fn) { fn(); return 1; },
    crypto: cryptoStub,
    supabase: {},
  };
  void leadId;
  win.window = win;
  // The bug: Auth.signUpWithPassword() throws Supabase's own literal
  // duplicate-registration error -- always AFTER register_partner has
  // already succeeded above, exactly the ordering every page uses.
  const AuthObj = {
    signUpWithPassword: async () => {
      callOrder.push('signUp');
      const mode = signUpSeq ? signUpSeq[Math.min(signUpN++, signUpSeq.length - 1)] : signUp;
      if (mode === 'ok') return { user: { id: 'gh2274-user-id' }, session: null };
      throw (dupError || new Error('User already registered'));
    },
    hasPartnerSession: async () => false,
    getUser: async () => (sessionEmail ? { email: sessionEmail } : null),
    isTestEmail: (email) => (email || '').trim().toLowerCase().endsWith('@otterquote-internal.test'),
  };
  win.Auth = AuthObj;
  const ctx = {
    history: win.history, supabase: {},
    window: win, document: doc, localStorage, sessionStorage,
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
    CONFIG: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON: 'anon', whenReady(cb) { cb(sb); }, SUPPORT_EMAIL: 'support@otterquote.com', SITE_URL: 'https://otterquote.com', DEMO_MODE: false },
    AgentTypes: { CHOOSER_LABELS: { re_agent: 'Real Estate Agent', insurance_agent: 'Insurance Agent', home_inspector: 'Home Inspector', adjuster: 'Adjuster', other: 'Other' } },
  };
  vm.createContext(ctx);
  try {
    vm.runInContext(script, ctx, { timeout: 5000 });
  } catch (e) {
    return { setupError: 'script execution error while loading the page: ' + e.message };
  }
  for (const fn of domContentLoadedListeners) { try { fn(); } catch (e) {} }
  return { store, rpcCalls, leadsCalls, alertCalls, callOrder, lsStore, ssStore, win, prefillResolvers };
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


const FIELDS = { 'first-name': 'Jane', 'last-name': 'Test', email: 'gh2084@otterquote-internal.test', phone: '3175551234', brokerage: 'Test Realty', terms: true };
const LEAD_ID = '3e8a7dc2-a6ab-465c-9b23-bdcc61732055';
const reHtml = fs.readFileSync(path.join(repoRoot, 'partner-re.html'), 'utf8');

async function scenario(opts) {
  const r = runPageScript(reHtml, opts);
  if (r.setupError) { ok(false, 'setup: ' + r.setupError); return null; }
  await submitForm(r, 'partner-form', FIELDS, { hasConfirmPopup: true });
  return r;
}
// Submit while get_lead_prefill is still in flight, THEN let it resolve.
async function scenarioSubmitBeforePrefill(opts, prefillRow) {
  const r = runPageScript(reHtml, { ...opts, deferPrefill: true });
  if (r.setupError) { ok(false, 'setup: ' + r.setupError); return null; }
  const submitted = submitForm(r, 'partner-form', FIELDS, { hasConfirmPopup: true });
  await new Promise((res) => setTimeout(res, 20));
  r.prefillInFlightAtSubmit = r.prefillResolvers.length > 0;
  r.insertsBeforeResolve = leadsWrites(r).length;
  r.prefillResolvers.forEach((fn) => fn(prefillRow));
  await submitted;
  return r;
}
const leadsWrites = (r) => r.leadsCalls.filter((c) => c.table === 'leads' && c.op);
const leadsRpcWrites = (r) => r.rpcCalls.filter((c) => /lead/i.test(c.name) && !/prefill/i.test(c.name));

// (a) router lead id present
{
  const r = await scenario({ search: '?v=e&lead=' + LEAD_ID, prefill: 'row' });
  if (r) {
    ok(r.win.__oqRouterLeadId === LEAD_ID && r.win.__oqRouterLeadConfirmed === true, '(a) the real head script captured the id and the prefill confirmed the row');
    ok(r.rpcCalls.some((c) => c.name === 'register_partner'), '(a) register_partner still runs on the signup');
    ok(leadsWrites(r).length === 0, '(a) with ?lead=<uuid> the page performs NO leads insert/upsert/update (found ' + leadsWrites(r).length + ')');
    ok(leadsRpcWrites(r).length === 0, '(a) no leads-writing RPC is called either (the router row already carries variant e)');
  }
}
// (b) direct visit, variant known from the URL
{
  const r = await scenario({ search: '?v=e' });
  if (r) {
    const w = leadsWrites(r);
    ok(w.length === 1 && w[0].op === 'insert', '(b) no lead id: exactly one leads insert (found ' + w.length + ')');
    ok(w.length === 1 && w[0].payload && w[0].payload.variant === 'e', '(b) the single insert carries variant e');
    ok(w.length === 1 && w[0].payload && w[0].payload.source === 're_agent', '(b) source stays re_agent');
  }
}
// (c) direct visit, variant unknown
{
  const r = await scenario({ search: '' });
  if (r) {
    const w = leadsWrites(r);
    ok(w.length === 1 && w[0].op === 'insert', '(c) no lead id, no variant: exactly one leads insert (found ' + w.length + ')');
    ok(w.length === 1 && !('variant' in w[0].payload), '(c) no variant key is sent when none is known');
  }
}
// (e) invalid / unconfirmed ids still write exactly one row (REVIEW FAIL fix)
{
  const r = await scenario({ search: '?v=e&lead=not-a-real-lead', prefill: 'none' });
  if (r) {
    const w = leadsWrites(r);
    ok(r.win.__oqRouterLeadId === 'not-a-real-lead' && !r.win.__oqRouterLeadConfirmed, '(e) garbage id: captured by the head script but never confirmed');
    ok(w.length === 1 && w[0].op === 'insert', '(e) ?lead=not-a-real-lead: exactly one leads insert (found ' + w.length + ')');
    ok(w.length === 1 && w[0].payload.variant === 'e' && w[0].payload.source === 're_agent', '(e) that insert carries variant e and source re_agent');
  }
}
{
  const r = await scenario({ search: '?v=e&oq_internal=1&lead=' + LEAD_ID, prefill: 'none' });
  if (r) {
    const w = leadsWrites(r);
    ok(w.length === 1 && w[0].op === 'insert', '(f) well-formed uuid, prefill returns no row: exactly one leads insert (found ' + w.length + ')');
    ok(w.length === 1 && w[0].headers['x-oq-internal'] === '1', '(f) the fallback insert keeps the x-oq-internal header (?oq_internal=1)');
  }
}
// (g)/(h) submit BEFORE get_lead_prefill resolves
{
  const r = await scenarioSubmitBeforePrefill({ search: '?v=e&lead=' + LEAD_ID }, { name: 'Jane Test', email: 'router@example.com', phone: '3175550000' });
  if (r) {
    ok(r.prefillInFlightAtSubmit && r.insertsBeforeResolve === 0, '(g) race setup: prefill was still in flight and nothing was inserted yet');
    ok(leadsWrites(r).length === 0, '(g) submit before prefill, prefill returns a row: ZERO direct inserts (found ' + leadsWrites(r).length + ')');
    ok(r.rpcCalls.some((c) => c.name === 'register_partner'), '(g) register_partner still runs');
  }
}
{
  const r = await scenarioSubmitBeforePrefill({ search: '?v=e&lead=' + LEAD_ID }, null);
  if (r) {
    const w = leadsWrites(r);
    ok(r.prefillInFlightAtSubmit, '(h) race setup: prefill was still in flight at submit');
    ok(w.length === 1 && w[0].op === 'insert', '(h) submit before prefill, prefill returns no row: exactly one insert (found ' + w.length + ')');
  }
}
// (d) static: the parallel insurance page never writes leads
{
  const ins = fs.readFileSync(path.join(repoRoot, 'partner-insurance.html'), 'utf8');
  ok(!/from\(\s*['"]leads['"]\s*\)/.test(ins), "(d) partner-insurance.html has no .from('leads') write");
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
