/**
 * gh-2150 RE-1 -- the dedicated realtor short-signup landing page
 * (re-1.html). Asserts (a) the page renders the APPROVED copy verbatim
 * (issue #2150 comment 5821403227, Dustin ruling comment 5832299784) and
 * (b) the real inline submit-handler script, run in a vm context, posts
 * through the shared P-1 register_partner path (gh-2154, partner-re.html
 * conventions) carrying the re-1 funnel id -- including the page-specific
 * fallback that stamps funnel_id="re-1" even when the visit carries no
 * query string at all, since this page only ever represents that one
 * funnel.
 *
 * Technique: same real-script-extraction + vm shim technique as
 * tests/gh2154-p1-short-signup.mjs, trimmed to this one page.
 *
 * Run: node tests/gh2150-re1-page.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const PAGE_FILE = 're-1.html';

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}
function failWithReason(label, reason) {
  console.log('FAIL: ' + label + ' -- ' + reason);
  fail++;
}

const html = fs.readFileSync(path.join(repoRoot, PAGE_FILE), 'utf8');

// ── (a) APPROVED COPY, verbatim, static check ────────────────────────────
// Every string here is quoted directly from issue #2150 comment
// 5821403227, approved as-posted by Dustin (comment 5832299784). A
// FAIL here means the shipped page no longer matches the approved wording.
const APPROVED_STRINGS = [
  ["H1", "Every Realtor's New Best Friend"],
  ["Subhead", "Send your clients to Otter Quotes for fast, competing repair bids — no extra work for you, and a referral fee when the job's done."],
  ["Bullet 1", "Your client gets multiple contractor bids without hunting for one."],
  ["Bullet 2", "Earn $200 when a referred job of $10,000+ completes."],
  ["Bullet 3", "Track every referral from your phone, in real time."],
  ["Agreement checkbox text", "I agree to Otter Quotes's"],
  ["Agreement checkbox text (Partner Terms link text)", "Partner Terms"],
  ["CTA", "Get My Referral Link"],
  ["Post-submit confirmation", "You're in! Install the Otter Quotes partner app, sign in with the account you just created, and your referral link will be waiting inside."],
  ["Fee sentence (D-301/D-305)", "$200 when a homeowner you refer completes a project of $10,000 or more. $50 on the same terms for referrals from partners you recruit."],
  ["D-266 disclaimer", "Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees."],
];
for (const [label, text] of APPROVED_STRINGS) {
  ok(html.includes(text), '(a) approved copy present verbatim -- ' + label);
}

// Field labels: Name · Email · Phone · Brokerage (S01 approved field set).
const FIELD_LABELS = ['Name', 'Email', 'Phone', 'Brokerage'];
for (const label of FIELD_LABELS) {
  const re = new RegExp('<label[^>]*>' + label + '</label>');
  ok(re.test(html), '(a) field label present -- "' + label + '"');
}

// Slug: the approved ruling names `re-1.html` explicitly.
ok(html.includes('https://otterquote.com/re-1.html'), '(a) canonical URL is https://otterquote.com/re-1.html');

// No password field on this step (same P-1 short-set rule as partner-re.html).
{
  const start = html.indexOf('<form');
  const end = html.indexOf('</form>', start);
  const formHtml = start !== -1 && end !== -1 ? html.slice(start, end) : '';
  const hasPasswordInput = /<input[^>]*type\s*=\s*"password"/i.test(formHtml);
  ok(!hasPasswordInput, '(a) no password field on the signup step');
}

// ── (b)/(c): dynamic checks -- run the REAL page script in a vm ─────────

function extractInlineScripts(src) {
  const scripts = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/type\s*=\s*"application\/ld\+json"/i.test(attrs)) continue;
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
    apply() { return proxy; },
  });
  return proxy;
}

function makeSb(rpcCalls) {
  return {
    rpc(name, params) {
      rpcCalls.push({ name, params });
      if (name === 'register_partner') {
        return Promise.resolve({ data: { id: 'gh2150-re1-test-id', unique_code: 'TESTCODE123' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from() { return makeChainable(); },
    auth: {
      onAuthStateChange() {},
      updateUser() { return Promise.resolve({ data: {}, error: null }); },
    },
  };
}

function makeElementStore() {
  const byId = new Map();
  const created = [];
  function makeEl(id, tag) {
    const el = {
      id, tag, value: '', checked: false, disabled: false,
      textContent: '', innerHTML: '', href: '', className: '', selected: false,
      style: {},
      children: [],
      _listeners: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
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

function runPageScript({ search } = {}) {
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

  const cryptoCounters = { getRandomValues: 0 };
  const mathCounters = { random: 0 };
  const realMathRandom = Math.random;
  const instrumentedMath = Object.create(Math);
  instrumentedMath.random = function (...args) {
    mathCounters.random++;
    return realMathRandom.apply(Math, args);
  };
  const cryptoStub = {
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
    cookie: '',
  };
  const win = {
    location: { search: search || '', hostname: 'otterquote.com', href: '', replace() {} },
    localStorage,
    addEventListener() {}, removeEventListener() {},
    crypto: cryptoStub,
  };
  win.window = win;
  const authCounters = { signUpWithPassword: 0 };
  const AuthObj = {
    signUpWithPassword: async () => {
      authCounters.signUpWithPassword++;
      return { session: null, user: { id: 'gh2150-re1-test-user-id' } };
    },
    hasPartnerSession: async () => false,
    isTestEmail: (email) => (email || '').trim().toLowerCase().endsWith('@otterquote-internal.test'),
  };
  win.Auth = AuthObj;
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
    fbq() {}, gtag() {},
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
  for (const fn of domContentLoadedListeners) {
    try { fn(); } catch (e) { /* ignore */ }
  }
  return { store, rpcCalls, cryptoCounters, mathCounters, authCounters, lsStore };
}

async function submitForm(runResult, fill) {
  const el = runResult.store.byId.get('partner-form');
  if (!el) throw new Error('no element with id #partner-form was ever referenced by the page script');
  for (const [id, val] of Object.entries(fill)) {
    const fieldEl = runResult.store.getElementById(id);
    if (typeof val === 'boolean') fieldEl.checked = val;
    else fieldEl.value = val;
  }
  const listeners = el._listeners.submit;
  if (!listeners || !listeners.length) {
    throw new Error('no submit listener was ever registered on #partner-form');
  }
  const fakeEvent = { preventDefault() {} };
  const results = listeners.map((fn) => fn(fakeEvent));
  const confirmBtn = runResult.store.created
    .slice()
    .reverse()
    .find((e) => e.textContent === 'Confirm & Continue');
  if (confirmBtn) confirmBtn.click();
  await Promise.all(results);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function fullFill(overrides = {}) {
  return {
    name: 'Jane Test',
    email: 'gh2150-re1-test@example.invalid',
    phone: '3175551234',
    brokerage: 'Test Realty Co',
    terms: true,
    ...overrides,
  };
}

// (b) NEGATIVE CONTROL: load, never submit -> zero register_partner calls.
{
  const run = runPageScript({ search: '?utm_campaign=re-1' });
  if (run.setupError) {
    failWithReason('(b) NEGATIVE CONTROL: loading without submitting makes zero register_partner calls', run.setupError);
  } else {
    const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
    ok(calls.length === 0, '(b) NEGATIVE CONTROL: loading the page and not submitting makes zero register_partner calls');
  }
}

// (c) full submit with funnel_id/fbclid/li_fat_id/utm_campaign carried
// through, matching the S14 destination URL convention.
{
  const QS = '?funnel_id=re-1&fbclid=TESTFBCLID&li_fat_id=TESTLI&utm_campaign=re-1&utm_source=meta';
  const run = runPageScript({ search: QS });
  if (run.setupError) {
    failWithReason('(c) submitting calls register_partner with p_funnel_id="re-1" and attribution params', run.setupError);
  } else {
    try {
      await submitForm(run, fullFill());
      const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
      ok(calls.length === 1, '(c) register_partner is called exactly once on a filled, agreed-to submit -- got ' + calls.length + ' call(s)');
      const params = calls[0] ? calls[0].params || {} : {};
      ok(params.p_funnel_id === 're-1', '(c) p_funnel_id="re-1" is passed (explicit URL param) -- got ' + JSON.stringify(params.p_funnel_id));
      ok(params.p_fbclid === 'TESTFBCLID', '(c) p_fbclid="TESTFBCLID" is passed -- got ' + JSON.stringify(params.p_fbclid));
      ok(params.p_li_fat_id === 'TESTLI', '(c) p_li_fat_id="TESTLI" is passed -- got ' + JSON.stringify(params.p_li_fat_id));
      ok(params.p_utm_campaign === 're-1', '(c) p_utm_campaign="re-1" is passed -- got ' + JSON.stringify(params.p_utm_campaign));
      ok(params.p_agent_type === 're_agent', '(c) p_agent_type="re_agent" (default) is passed -- got ' + JSON.stringify(params.p_agent_type));
      ok(params.p_first_name === 'Jane' && params.p_last_name === 'Test', '(c) the single Name field is split into p_first_name/p_last_name -- got ' + JSON.stringify({ f: params.p_first_name, l: params.p_last_name }));
    } catch (e) {
      failWithReason('(c) submitting calls register_partner with p_funnel_id="re-1" and attribution params', e.message);
    }
  }
}

// (d) gh-2150 page-specific fallback: a visit with NO query string at all
// still stamps p_funnel_id="re-1", since this page only ever represents
// that one funnel.
{
  const run = runPageScript({ search: '' });
  if (run.setupError) {
    failWithReason('(d) with no query string at all, p_funnel_id still defaults to "re-1"', run.setupError);
  } else {
    try {
      await submitForm(run, fullFill());
      const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
      const params = calls[0] ? calls[0].params || {} : {};
      ok(params.p_funnel_id === 're-1', '(d) with no query string at all, p_funnel_id still defaults to "re-1" -- got ' + JSON.stringify(params.p_funnel_id));
    } catch (e) {
      failWithReason('(d) with no query string at all, p_funnel_id still defaults to "re-1"', e.message);
    }
  }
}

// (e) NEGATIVE CONTROL: submit without the agreement box ticked -> zero calls.
{
  const run = runPageScript({ search: '?utm_campaign=re-1' });
  if (run.setupError) {
    failWithReason('(e) NEGATIVE CONTROL: submitting without the agreement checkbox makes zero register_partner calls', run.setupError);
  } else {
    try {
      await submitForm(run, fullFill({ terms: false }));
      const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
      ok(calls.length === 0, '(e) NEGATIVE CONTROL: submitting without the agreement checkbox ticked makes zero register_partner calls -- got ' + calls.length + ' call(s)');
    } catch (e) {
      failWithReason('(e) NEGATIVE CONTROL: submitting without the agreement checkbox makes zero register_partner calls', e.message);
    }
  }
}

// (f) CSPRNG: crypto.getRandomValues called exactly once per submit, never
// Math.random (same gh-2154 P-1 CSPRNG-fix convention as partner-re.html).
{
  const run = runPageScript({ search: '?utm_campaign=re-1' });
  if (run.setupError) {
    failWithReason('(f) crypto.getRandomValues called exactly once per submit, never Math.random', run.setupError);
  } else {
    try {
      await submitForm(run, fullFill());
      ok(run.cryptoCounters.getRandomValues === 1, '(f) crypto.getRandomValues() called exactly once on submit -- got ' + run.cryptoCounters.getRandomValues);
      ok(run.mathCounters.random === 0, '(f) Math.random() is never called in the signup path -- got ' + run.mathCounters.random + ' call(s)');
    } catch (e) {
      failWithReason('(f) crypto.getRandomValues called exactly once per submit, never Math.random', e.message);
    }
  }
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
