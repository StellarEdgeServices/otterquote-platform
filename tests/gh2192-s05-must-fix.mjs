/**
 * gh-2192 REVIEW FAIL 5838866942 -- two must-fixes on re-1.html, ins-1.html
 * and hi-1.html, on top of the S05 perf work (#2150/#2151/#2152).
 *
 * Run against BOTH the pre-fix blob at dc7135be (via `git show`) and the
 * current on-disk file, so every assertion below is fail-first: it FAILS
 * against dc7135be and PASSES against the fix in this worktree.
 *
 * (1) recruit-code attribution (ins-1.html, hi-1.html): detectRecruitCode()
 *     used to run ONLY via CONFIG.whenReady(sb => detectRecruitCode()),
 *     which now only fires once the lazily-loaded Supabase bundle is ready.
 *     A submit that is the visitor's very first interaction races that
 *     callback -- ensureSb() resolves as soon as the client exists, but
 *     detectRecruitCode()'s own network round trip can still be pending,
 *     so register_partner could fire with p_recruit_code still null. The
 *     fix explicitly awaits detectRecruitCode() (idempotent, cached) right
 *     after ensureSb() resolves, before building the RPC payload.
 *     re-1.html never had a recruit-code feature (p_recruit_code is a
 *     hardcoded null on both main and dc7135be) -- checked here as a
 *     negative control, not a defect.
 *
 * (2) pre-hydration submit (re-1.html, ins-1.html, hi-1.html): a submit
 *     tapped before this page's own deferred scripts attach the real
 *     handler previously fell through to the browser's native form submit
 *     -- a GET, since no method/action override existed -- reloading the
 *     page and carrying name/email/phone/company/brokerage in the URL on
 *     ins-1/hi-1. The fix adds an early, capture-phase guard (the #2183
 *     early-tap pattern) right after </form>, well before the relocated
 *     scripts even start loading: it forces method=post + an inert action,
 *     always preventDefault()s, and queues at most one pre-hydration
 *     submit for exactly-once replay through the real handler once it
 *     registers via window.__oqRegisterFormSubmit.
 *
 * Run: node tests/gh2192-s05-must-fix.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let pass = 0, fail = 0;
let preFixPass = 0, preFixFail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}
function failWithReason(label, reason) {
  console.log('FAIL: ' + label + ' -- ' + reason);
  fail++;
}
// For the dc7135be (pre-fix) half of a fail-first pair: the whole POINT is
// that this condition is true (the bug reproduces / no guard exists yet)
// on that historical blob. It documents the bug for the record but must
// never fail the overall exit code -- only the post-fix assertions do
// that -- so it is tracked in a separate counter.
function preFixExpect(cond, label) {
  if (cond) { console.log('PASS (documents pre-fix bug): ' + label); preFixPass++; }
  else { console.log('FAIL (documents pre-fix bug): ' + label); preFixFail++; }
}

// CI checkouts are often shallow (actions/checkout's default fetch-depth:
// 1), so dc7135be -- an ancestor of whatever commit is actually checked
// out once later commits land on this branch -- may not be locally
// reachable. Try once to fetch just that commit; if that also fails (no
// network, or the ref is genuinely gone), gitShow() returns null and every
// pre-fix/dc7135be assertion below is skipped rather than erroring the
// whole suite -- the post-fix assertions (the ones that actually gate CI)
// never depend on this.
let __oqDc7135beFetchAttempted = false;
function ensureDc7135beReachable() {
  if (__oqDc7135beFetchAttempted) return;
  __oqDc7135beFetchAttempted = true;
  try {
    execFileSync('git', ['cat-file', '-e', 'dc7135be^{commit}'], { cwd: repoRoot });
  } catch (e) {
    try {
      execFileSync('git', ['fetch', '--depth=50', 'origin', 'dc7135be'], { cwd: repoRoot, stdio: 'ignore' });
    } catch (e2) { /* best effort -- gitShow() below reports null if this didn't help */ }
  }
}
function gitShow(ref, file) {
  ensureDc7135beReachable();
  try {
    return execFileSync('git', ['show', ref + ':' + file], { cwd: repoRoot, encoding: 'utf8' });
  } catch (e) {
    return null;
  }
}
import fs from 'node:fs';
function readDisk(file) {
  return fs.readFileSync(path.join(repoRoot, file), 'utf8');
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
  return scripts;
}

function makeElementStore() {
  const byId = new Map();
  const created = [];
  function makeEl(id, tag) {
    const classes = new Set();
    const el = {
      id, tag, value: '', checked: false, disabled: false, files: [],
      textContent: '', innerHTML: '', href: '', className: '', selected: false,
      style: {}, children: [], _listeners: {}, _attrs: {}, onload: null, onerror: null,
      classList: {
        add(...names) { names.forEach((n) => classes.add(n)); },
        remove(...names) { names.forEach((n) => classes.delete(n)); },
        toggle() {},
        contains(n) { return classes.has(n); },
      },
      addEventListener(type, fn, opts) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
      removeEventListener() {},
      appendChild(child) {
        el.children.push(child);
        // Simulate the dynamically-injected Supabase <script> finishing its
        // network fetch quickly -- CONFIG actually becoming ready (the
        // config.js poll noticing the freshly-loaded global) is a SEPARATE,
        // test-controlled step (triggerConfigReady()), same as production
        // where config.js's own whenReady/poll loop is what actually gates
        // client construction, not the script tag's load event by itself.
        if (child && child.tag === 'script' && typeof child.onload === 'function') {
          child.onload();
        }
        return child;
      },
      removeChild() {},
      focus() { (el._listeners.focus || []).forEach((fn) => fn({})); },
      click() { (el._listeners.click || []).forEach((fn) => fn({})); },
      scrollIntoView() {},
      querySelector() { return makeEl('__anon__', 'div'); },
      querySelectorAll() { return []; },
      setAttribute(k, v) { el._attrs[k] = v; }, getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
      removeAttribute(k) { delete el._attrs[k]; },
    };
    return el;
  }
  return {
    getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl(id, 'div')); return byId.get(id); },
    createElement(tag) { const el = makeEl('__created_' + created.length, tag); created.push(el); return el; },
    byId, created,
  };
}

/**
 * Builds a fresh vm context for one page. `configDelay` controls how
 * CONFIG.whenReady behaves: 'sync' resolves every callback immediately
 * (like the harness in tests/gh2151-ins1-page.mjs); 'manual' queues
 * callbacks until the test calls ctx.__test_triggerConfigReady().
 * `recruitLookupDelay` controls whether the mocked recruit-code RPC
 * resolves on the same microtask turn ('sync') or after a macrotask
 * (setTimeout) delay ('delayed') -- 'delayed' is what actually exposes the
 * must-fix (1) race, because ensureSb() resolving is a pure microtask
 * chain and would otherwise reliably win the race against it.
 */
function makeContext({ search, configDelay, recruitLookupDelay, localStorageSeed }) {
  const store = makeElementStore();
  const rpcCalls = [];
  const gtagCalls = [];
  const configQueue = [];
  let configReadySb = null;
  const sb = {
    rpc(name, params) {
      rpcCalls.push({ name, params: params || {} });
      if (name === 'register_partner') {
        return Promise.resolve({ data: { id: 'gh2192-test-id', unique_code: 'TESTCODE123' }, error: null });
      }
      if (name === 'get_referral_agents_public') {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          maybeSingle() {
            const result = { data: { id: 'recruiter-1', first_name: 'Ren', last_name: 'Cruiter', company: 'RC Co' }, error: null };
            if (recruitLookupDelay === 'delayed') {
              return new Promise((resolve) => setTimeout(() => resolve(result), 0));
            }
            return Promise.resolve(result);
          },
        };
        return builder;
      }
      return Promise.resolve({ data: null, error: null });
    },
    from() { return new Proxy(function () {}, { get: () => () => new Proxy(function () {}, { get: () => () => Promise.resolve({ data: null, error: null }) }) }); },
    storage: { from() { return { upload: () => Promise.resolve({ data: { path: 'x' }, error: null }), getPublicUrl: () => ({ data: { publicUrl: null } }) }; } },
    auth: { onAuthStateChange() {}, updateUser() { return Promise.resolve({ data: {}, error: null }); } },
  };
  const lsStore = new Map();
  for (const [k, v] of Object.entries(localStorageSeed || {})) lsStore.set(k, v);
  const localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => { lsStore.set(k, String(v)); },
    removeItem: (k) => { lsStore.delete(k); },
  };
  const cryptoStub = { getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = i % 256; return arr; } };
  const domContentLoadedListeners = [];
  const headEl = store.createElement('head');
  const doc = {
    referrer: '',
    head: headEl,
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
    documentElement: store.createElement('html'),
  };
  const win = {
    location: { search: search || '', hostname: 'otterquote.com', href: '', replace() {} },
    localStorage,
    addEventListener() {}, removeEventListener() {},
    scrollTo() {},
    requestIdleCallback(fn) { fn(); return 1; },
    crypto: cryptoStub,
    supabase: undefined,
  };
  win.window = win;
  const AuthObj = {
    signUpWithPassword: async () => ({ session: null, user: { id: 'gh2192-test-user-id' } }),
    hasPartnerSession: async () => false,
    getUser: async () => null,
    isTestEmail: (email) => (email || '').trim().toLowerCase().endsWith('@otterquote-internal.test'),
  };
  win.Auth = AuthObj;
  const CONFIG = {
    whenReady(cb) {
      if (configDelay === 'sync' || configReadySb !== null) { cb(configReadySb !== null ? configReadySb : sb); return; }
      configQueue.push(cb);
    },
    SUPPORT_EMAIL: 'support@otterquote.com', SITE_URL: 'https://otterquote.com', DEMO_MODE: false,
  };
  function triggerConfigReady() {
    configReadySb = sb;
    win.supabase = { createClient() { return sb; } };
    const q = configQueue.splice(0, configQueue.length);
    q.forEach((cb) => cb(sb));
  }
  const ctx = {
    window: win, document: doc, localStorage,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    console, URLSearchParams,
    Promise, JSON, Date, Math, Array, Object, String, Number, Boolean, RegExp,
    Uint8Array, btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
    crypto: cryptoStub,
    setTimeout, clearTimeout, setInterval, clearInterval,
    decodeURIComponent, encodeURIComponent,
    alert() {}, confirm() { return true; },
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
    fbq() {}, gtag(cmd, name, params) { gtagCalls.push({ cmd, name, params }); },
    Sentry: new Proxy({}, { get: () => (...args) => { const cb = args.find((a) => typeof a === 'function'); if (cb) cb({ setTag() {}, setContext() {}, setLevel() {}, setUser() {} }); } }),
    Auth: AuthObj,
    CONFIG, sb,
    AgentTypes: { CHOOSER_LABELS: { re_agent: 'Real Estate Agent', insurance_agent: 'Insurance Agent', home_inspector: 'Home Inspector', adjuster: 'Adjuster', other: 'Other' } },
  };
  vm.createContext(ctx);
  return { ctx, store, rpcCalls, gtagCalls, triggerConfigReady, domContentLoadedListeners };
}

function runScript(ctx, scriptSrc) {
  vm.runInContext(scriptSrc, ctx, { timeout: 5000 });
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

// ── (1) recruit-code race on ins-1.html / hi-1.html ──────────────────────
async function testRecruitCodeRace(pageFile, formId, fields, label) {
  for (const [source, html] of [
    ['dc7135be (pre-fix)', gitShow('dc7135be', pageFile)],
    ['current worktree (post-fix)', readDisk(pageFile)],
  ]) {
    if (html === null) { console.log('SKIP: ' + label + ' [' + source + '] -- dc7135be not reachable in this checkout (shallow clone); post-fix assertions are unaffected'); continue; }
    const scripts = extractInlineScripts(html);
    const joined = scripts.join('\n;\n');
    if (!joined || joined.indexOf('register_partner') === -1) {
      failWithReason(label + ' [' + source + ']', 'no inline script containing register_partner was found');
      continue;
    }
    const { ctx, store, rpcCalls, triggerConfigReady } = makeContext({
      search: '',
      configDelay: 'manual',
      recruitLookupDelay: 'delayed',
      localStorageSeed: { cs_recruit_code: 'RVREC' },
    });
    try {
      runScript(ctx, joined);
    } catch (e) {
      failWithReason(label + ' [' + source + ']', 'script execution error: ' + e.message);
      continue;
    }
    // Fill and submit as the visitor's very first interaction with the
    // form -- no prior focus/touchstart, so nothing has triggered the
    // lazy Supabase load yet.
    for (const [id, val] of Object.entries(fields)) {
      const el = store.getElementById(id);
      if (typeof val === 'boolean') el.checked = val; else el.value = val;
    }
    const listeners = store.byId.get(formId) && store.byId.get(formId)._listeners.submit;
    if (!listeners || !listeners.length) {
      failWithReason(label + ' [' + source + ']', 'no submit listener was ever registered on #' + formId);
      continue;
    }
    const submitPromise = Promise.resolve(listeners[0]({ preventDefault() {} }));
    // Let the microtask chain (ensureSb's CONFIG.whenReady wait) queue up,
    // THEN resolve CONFIG -- this is the moment ensureSb() unblocks. The
    // mocked recruit-code lookup is macrotask-delayed (setTimeout), so if
    // the submit handler does not explicitly await detectRecruitCode(),
    // it will reach register_partner before the lookup resolves.
    await flush(1);
    triggerConfigReady();
    await submitPromise;
    await flush(6);
    const call = rpcCalls.find((c) => c.name === 'register_partner');
    const gotRecruitCode = !!call && call.params.p_recruit_code === 'RVREC';
    if (source.includes('pre-fix')) {
      preFixExpect(!gotRecruitCode, label + ' [' + source + ']: (fail-first control) confirms the bug -- p_recruit_code is dropped on an immediate first-interaction submit -- got ' + JSON.stringify(call && call.params.p_recruit_code));
    } else {
      ok(gotRecruitCode, label + ' [' + source + ']: p_recruit_code="RVREC" reaches register_partner on an immediate first-interaction submit -- got ' + JSON.stringify(call && call.params.p_recruit_code));
    }
  }
}

await testRecruitCodeRace('ins-1.html', 'insuranceAgentForm', {
  fullName: 'Jane Test', email: 'gh2192-ins1-test@example.invalid', phone: '3175551234', company: 'Test Agency', agreeToTerms: true,
}, 'ins-1.html must-fix (1)');

await testRecruitCodeRace('hi-1.html', 'homeInspectorForm', {
  fullName: 'Jane Test', email: 'gh2192-hi1-test@example.invalid', phone: '3175551234', company: 'Test Co', agreeToTerms: true,
}, 'hi-1.html must-fix (1)');

// re-1.html negative control: no recruit-code feature exists on this page
// at all (p_recruit_code is a hardcoded null on both dc7135be and main) --
// confirmed here so the "check re-1.html for the same class of bug" ask is
// answered, not skipped.
{
  const before = gitShow('dc7135be', 're-1.html');
  const after = readDisk('re-1.html');
  if (before === null) {
    console.log('SKIP: re-1.html negative control [dc7135be] -- dc7135be not reachable in this checkout (shallow clone)');
  } else {
    ok(/p_recruit_code:\s*null/.test(before), 're-1.html negative control: p_recruit_code is a hardcoded null at dc7135be (no recruit-code feature to race)');
  }
  ok(/p_recruit_code:\s*null/.test(after), 're-1.html negative control: p_recruit_code is still a hardcoded null after this fix (unchanged, by design)');
  ok(!/detectRecruitCode/.test(after), 're-1.html negative control: no detectRecruitCode() function was introduced');
}

// ── (2) pre-hydration submit -- queued, no native GET, replayed once ─────
async function testEarlyTapGuard(pageFile, formId, fields, label) {
  for (const [source, html] of [
    ['dc7135be (pre-fix)', gitShow('dc7135be', pageFile)],
    ['current worktree (post-fix)', readDisk(pageFile)],
  ]) {
    if (html === null) { console.log('SKIP: ' + label + ' [' + source + '] -- dc7135be not reachable in this checkout (shallow clone); post-fix assertions are unaffected'); continue; }
    // Structural check first: is there ANY early, capture-phase guard that
    // forces method=post + an inert action before the real handler exists?
    const formOpenMatch = new RegExp('<form\\b[^>]*id="' + formId + '"[^>]*>').exec(html);
    const hasPostMethod = !!formOpenMatch && /method\s*=\s*"post"/i.test(formOpenMatch[0]);
    const hasEarlyGuard = /__oqRegisterFormSubmit/.test(html);
    if (source.includes('post-fix')) {
      ok(hasEarlyGuard, label + ' [' + source + ']: an early window.__oqRegisterFormSubmit guard exists');
    } else {
      preFixExpect(!hasEarlyGuard, label + ' [' + source + ']: (fail-first control) dc7135be has no early-tap guard yet');
    }

    const scripts = extractInlineScripts(html);
    if (!hasEarlyGuard) {
      // Pre-fix: the only submit listener is the real handler itself,
      // attached late by the big deferred script. The actual defect is
      // that BEFORE any script runs, a submit tap is a plain native
      // browser action, which this vm harness (which only ever runs
      // scripts, never the browser's own default action) cannot literally
      // reproduce -- so we assert directly against the markup instead: no
      // method="post" override existed, meaning the browser's default
      // action (GET, current URL, PII in the query string on ins-1/hi-1)
      // was live the entire time before hydration.
      preFixExpect(!hasPostMethod, label + ' [' + source + ']: (fail-first control) confirms the vulnerability -- no method="post" override existed at dc7135be, so a pre-hydration tap fell through to a native GET');
      continue;
    }

    const guardScript = scripts.find((s) => s.indexOf('__oqRegisterFormSubmit') !== -1 && s.indexOf('addEventListener') !== -1 && s.indexOf('function (fn)') !== -1);
    const restScripts = scripts.filter((s) => s !== guardScript);
    if (!guardScript) {
      failWithReason(label + ' [' + source + ']', 'could not isolate the early-tap guard script');
      continue;
    }
    const { ctx, store, rpcCalls, triggerConfigReady } = makeContext({ search: '', configDelay: 'sync', recruitLookupDelay: 'sync', localStorageSeed: {} });
    try {
      runScript(ctx, guardScript);
    } catch (e) {
      failWithReason(label + ' [' + source + ']', 'guard script execution error: ' + e.message);
      continue;
    }
    const formEl = store.getElementById(formId);
    ok(formEl._attrs.method === 'post', label + ' [' + source + ']: the guard sets method="post" on #' + formId + ' synchronously');
    ok(typeof formEl._attrs.action === 'string' && formEl._attrs.action !== '', label + ' [' + source + ']: the guard sets an inert action on #' + formId);

    // Fill fields and fire a submit RIGHT NOW, before the real handler
    // (further down in the file, in a script that hasn't run yet) exists.
    for (const [id, val] of Object.entries(fields)) {
      const el = store.getElementById(id);
      if (typeof val === 'boolean') el.checked = val; else el.value = val;
    }
    let defaultPrevented = false;
    const listeners = formEl._listeners.submit;
    ok(!!listeners && listeners.length === 1, label + ' [' + source + ']: exactly one submit listener exists before hydration');
    listeners[0]({ preventDefault() { defaultPrevented = true; } });
    ok(defaultPrevented, label + ' [' + source + ']: the pre-hydration tap never falls through to a native submit (preventDefault called synchronously)');

    // A second early tap must not queue a second submission.
    listeners[0]({ preventDefault() {} });

    // Now "hydration" happens: the rest of the page's scripts run and
    // register the real handler.
    const joined = restScripts.join('\n;\n');
    try {
      runScript(ctx, joined);
    } catch (e) {
      failWithReason(label + ' [' + source + ']', 'main script execution error: ' + e.message);
      continue;
    }
    await flush(8);
    const calls = rpcCalls.filter((c) => c.name === 'register_partner');
    ok(calls.length === 1, label + ' [' + source + ']: the queued pre-hydration submit is replayed exactly once (no double-submit) -- got ' + calls.length + ' register_partner call(s)');
  }
}

await testEarlyTapGuard('re-1.html', 'partner-form', {
  name: 'Jane Realtor', email: 'gh2192-re1-test@example.invalid', phone: '3175551234', brokerage: 'Test Brokerage', terms: true,
}, 're-1.html must-fix (2)');

await testEarlyTapGuard('ins-1.html', 'insuranceAgentForm', {
  fullName: 'Jane Test', email: 'gh2192-ins1-test2@example.invalid', phone: '3175551234', company: 'Test Agency', agreeToTerms: true,
}, 'ins-1.html must-fix (2)');

await testEarlyTapGuard('hi-1.html', 'homeInspectorForm', {
  fullName: 'Jane Test', email: 'gh2192-hi1-test2@example.invalid', phone: '3175551234', company: 'Test Co', agreeToTerms: true,
}, 'hi-1.html must-fix (2)');

console.log('\n' + pass + ' passed, ' + fail + ' failed (post-fix assertions -- these gate CI)');
console.log(preFixPass + ' passed, ' + preFixFail + ' failed (pre-fix/dc7135be bug-documentation assertions -- informational only, never gate CI)');
process.exit(fail === 0 ? 0 : 1);
