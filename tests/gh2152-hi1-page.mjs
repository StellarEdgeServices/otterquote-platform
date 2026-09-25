/**
 * gh-2152 HI-1 -- the dedicated home-inspector landing page (hi-1.html),
 * built after #2166 (HI-0b) merged 8d8e92b9 per Dustin's ruling on #2152
 * comment 5832300782 ("APPROVED. Approved as posted, including the slug
 * hi-1.html, no fee language, and no D-266 disclaimer (inspectors take no
 * fee, D-333)."). P-1 (short signup) and P-2 (attribution: fbclid/li_fat_id/
 * funnel_id) are already on main -- this page reuses that exact wiring,
 * unmodified, from partner-inspectors.html/ins-1.html/re-1.html.
 *
 * Asserts:
 *   (a) every approved copy string from #2152 comment 5821414324 is
 *       present verbatim on the rendered page (H1, subhead, 3 benefit
 *       bullets, agreement checkbox text, CTA, no-fee statement,
 *       post-submit confirmation).
 *   (b) the short field set (name/email/phone/company + checkbox, no
 *       visible password) with field labels "Name / Email / Phone /
 *       Company".
 *   (c) NO fee sentence and NO D-266 disclaimer anywhere on the page
 *       (D-333: home inspectors receive no referral fee or recruit bonus;
 *       Dustin's ruling explicitly waives D-266 here) -- and no bare `$`
 *       amount anywhere in the rendered HTML.
 *   (d) NEGATIVE CONTROL: loading without submitting makes zero
 *       register_partner calls.
 *   (e) a full submit calls register_partner with p_agent_type
 *       ="home_inspector", p_company from the Company field, and
 *       p_funnel_id="hi-1" derived from utm_campaign=hi-1 on the ad
 *       URL (same P-2 fallback regex partner-inspectors.html/ins-1.html
 *       use).
 *   (f) dark-launch gate: <meta name="robots" content="noindex, nofollow">
 *       is present (HI-1 must not be indexed or linked until
 *       HI-1.S24 CLOSE-REVIEW passes and Dustin publishes it).
 *
 * Technique: extract the REAL inline <script> source (never a
 * hand-retyped copy) and run it in a `vm` context behind a minimal DOM/
 * Auth/Supabase/CONFIG shim, then drive the real submit handler exactly
 * as a browser would -- same technique as tests/gh2151-ins1-page.mjs /
 * tests/gh2154-p1-short-signup.mjs.
 *
 * Run: node tests/gh2152-hi1-page.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const PAGE_FILE = 'hi-1.html';

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}
function failWithReason(label, reason) {
  console.log('FAIL: ' + label + ' -- ' + reason);
  fail++;
}

// ── (a) approved copy, verbatim (#2152 comment 5821414324) ──────────────
const APPROVED_STRINGS = [
  ['H1', 'A Real Next Step When You Find Damage'],
  ['Subhead', 'Give your clients a co-branded link to competing repair bids when your report flags damage — a better next step than a business card.'],
  ['Bullet 1', 'Your client gets multiple contractor bids without hunting for one.'],
  ['Bullet 2', 'Share your link right in the report — no extra step for you.'],
  ['Bullet 3', 'Track shares and outcomes from your phone.'],
  ['CTA', 'Get My Link'],
  ['Agreement checkbox text', "I agree to Otter Quotes's Partner Terms"],
  ['No-fee statement (D-333, verbatim)', 'Home-inspector partners do not receive a referral fee or recruit bonus.'],
  ['Post-submit confirmation', "Install the Otter Quotes partner app, sign in with the account you just created, and your link will be waiting inside to add to your reports."],
];

const html = fs.readFileSync(path.join(repoRoot, PAGE_FILE), 'utf8');

// Verbatim-copy match, tolerant of inline markup and incidental whitespace
// -- same normalize() as tests/gh2151-ins1-page.mjs.
function normalize(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
const normalizedHtml = normalize(html);

for (const [label, text] of APPROVED_STRINGS) {
  ok(normalizedHtml.includes(normalize(text)), 'hi-1.html (a): approved copy present verbatim -- ' + label);
}

// ── (b) short field set + labels ─────────────────────────────────────
function extractForm(h) {
  const start = h.indexOf('<form');
  const end = h.indexOf('</form>', start);
  if (start === -1 || end === -1) return null;
  return h.slice(start, end + '</form>'.length);
}
const formHtml = extractForm(html);
if (!formHtml) {
  failWithReason('hi-1.html (b): form present with the short field set', 'no <form>...</form> found');
} else {
  const inputRe = /<input\b([^>]*)>/gi;
  const inputs = [];
  let m;
  while ((m = inputRe.exec(formHtml))) {
    const attrs = m[1];
    const idM = /\bid\s*=\s*"([^"]+)"/i.exec(attrs);
    const typeM = /\btype\s*=\s*"([^"]+)"/i.exec(attrs);
    inputs.push({ id: idM ? idM[1] : null, type: typeM ? typeM[1].toLowerCase() : 'text' });
  }
  const passwordFields = inputs.filter((i) => i.type === 'password');
  ok(passwordFields.length === 0, 'hi-1.html (b): NO visible password field on the signup step');
  ok(inputs.some((i) => i.id === 'fullName'), 'hi-1.html (b): Name field present (#fullName)');
  ok(inputs.some((i) => i.id === 'email'), 'hi-1.html (b): Email field present (#email)');
  ok(inputs.some((i) => i.id === 'phone'), 'hi-1.html (b): Phone field present (#phone)');
  ok(inputs.some((i) => i.id === 'company'), 'hi-1.html (b): Company field present (#company)');
  ok(inputs.some((i) => i.type === 'checkbox'), 'hi-1.html (b): agreement checkbox present');
}
ok(/<label for="fullName"[^>]*>Name<\/label>/.test(html), 'hi-1.html (b): field label "Name"');
ok(/<label for="phone"[^>]*>Phone<\/label>/.test(html), 'hi-1.html (b): field label "Phone"');
ok(/<label for="company"[^>]*>Company<\/label>/.test(html), 'hi-1.html (b): field label "Company"');

// ── (c) no fee sentence, no D-266 disclaimer, no bare $ amount ──────────
ok(!/\$\d/.test(html), 'hi-1.html (c): no dollar-amount fee language anywhere in the served HTML');
ok(!normalizedHtml.includes(normalize('Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.')), 'hi-1.html (c): NO D-266 disclaimer (waived for home_inspector, D-333)');
ok(!normalizedHtml.includes(normalize('Recruit Bonus')) || normalizedHtml.includes(normalize('do not receive a referral fee or recruit bonus')), 'hi-1.html (c): any "Recruit Bonus" mention is only inside the no-fee statement, never a fee amount');
ok(/track=home_inspector/.test(html), 'hi-1.html (c): Partner Agreement links carry ?track=home_inspector so HI-0.5\'s hide holds for a visitor who clicks through from this page');

// ── (f) dark-launch gate ─────────────────────────────────────────────
ok(/<meta name="robots" content="noindex, nofollow">/.test(html), 'hi-1.html (f): noindex/nofollow present (dark launch -- not linked/indexed until S24 CLOSE-REVIEW + Dustin publishes)');

// ── (d)/(e) dynamic checks -- run the REAL page script in a vm ──────────

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
    const el = {
      id, tag, value: '', checked: false, disabled: false, files: [],
      textContent: '', innerHTML: '', href: '', className: '', selected: false,
      style: {}, children: [], _listeners: {},
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
      scrollIntoView() {},
      querySelector() { return makeEl('__anon__', 'div'); },
      querySelectorAll() { return []; },
      setAttribute() {}, getAttribute() { return null; },
    };
    return el;
  }
  return {
    getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl(id, 'div')); return byId.get(id); },
    createElement(tag) { const el = makeEl('__created_' + created.length, tag); created.push(el); return el; },
    byId, created,
  };
}

function runPageScript(search) {
  const script = extractInlineScripts(html);
  if (!script || script.indexOf('register_partner') === -1) {
    return { setupError: 'no inline script containing register_partner was found on the page' };
  }
  const store = makeElementStore();
  const rpcCalls = [];
  const sb = {
    rpc(name, params) {
      rpcCalls.push({ name, params });
      if (name === 'register_partner') {
        return Promise.resolve({ data: { id: 'gh2152-hi1-test-id', unique_code: 'TESTCODE456' }, error: null });
      }
      if (name === 'claim_partner_account') {
        return Promise.resolve({ data: { claimed: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from() { return new Proxy(function () {}, { get: () => () => new Proxy(function () {}, { get: () => () => Promise.resolve({ data: null, error: null }) }) }); },
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
  };
  win.window = win;
  const AuthObj = {
    signUpWithPassword: async () => ({ session: null, user: { id: 'gh2152-hi1-test-user-id' } }),
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
    alert() {}, confirm() { return true; },
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
  return { store, rpcCalls };
}

async function submitForm(runResult, formId, fill) {
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
  const confirmBtn = runResult.store.created.slice().reverse().find((e) => e.textContent === 'Confirm & Continue');
  if (confirmBtn) confirmBtn.click();
  await Promise.all(results);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

// (d) NEGATIVE CONTROL: an ad-URL load with utm_campaign=hi-1, no submit -> zero calls.
const AD_QS = '?utm_source=meta&utm_medium=paid_social&utm_campaign=hi-1&utm_content=creative1';
{
  const run = runPageScript(AD_QS);
  if (run.setupError) {
    failWithReason('hi-1.html (d) NEGATIVE CONTROL: loading without submitting makes zero register_partner calls', run.setupError);
  } else {
    const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
    ok(calls.length === 0, 'hi-1.html (d) NEGATIVE CONTROL: loading the page and not submitting makes zero register_partner calls');
  }
}

// (e) full submit -- p_funnel_id="hi-1" derived from utm_campaign=hi-1, p_agent_type="home_inspector".
{
  const run = runPageScript(AD_QS);
  if (run.setupError) {
    failWithReason('hi-1.html (e): submitting calls register_partner with p_funnel_id="hi-1" and p_agent_type="home_inspector"', run.setupError);
  } else {
    try {
      await submitForm(run, 'homeInspectorForm', {
        fullName: 'Jane Test',
        email: 'gh2152-hi1-test@example.invalid',
        phone: '3175551234',
        company: 'Test Inspections',
        agreeToTerms: true,
      });
      const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
      ok(calls.length === 1, 'hi-1.html (e): register_partner is called exactly once on a filled, agreed-to submit -- got ' + calls.length + ' call(s)');
      const params = calls[0] ? calls[0].params || {} : {};
      ok(params.p_funnel_id === 'hi-1', 'hi-1.html (e): p_funnel_id="hi-1" is passed (derived from utm_campaign) -- got ' + JSON.stringify(params.p_funnel_id));
      ok(params.p_utm_campaign === 'hi-1', 'hi-1.html (e): p_utm_campaign="hi-1" is passed -- got ' + JSON.stringify(params.p_utm_campaign));
      ok(params.p_agent_type === 'home_inspector', 'hi-1.html (e): p_agent_type="home_inspector" is passed -- got ' + JSON.stringify(params.p_agent_type));
      ok(params.p_company === 'Test Inspections', 'hi-1.html (e): p_company (Company field) is passed -- got ' + JSON.stringify(params.p_company));
    } catch (e) {
      failWithReason('hi-1.html (e): submitting calls register_partner with p_funnel_id="hi-1" and p_agent_type="home_inspector"', e.message);
    }
  }
}

console.log('');
console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
