/**
 * gh-2151 INS-1 -- the dedicated insurance-agent landing page (ins-1.html),
 * built ahead of #2154's P-3/P-4/P-5 close per Dustin's ruling on #2151
 * comment 5832300528 ("Approved as posted, including the slug ins-1.html.
 * INS-1 builds when #2154 is [check]."). P-1 (short signup) and P-2
 * (attribution: fbclid/li_fat_id/funnel_id) are already on main -- this
 * page reuses that exact wiring, unmodified, from partner-insurance.html.
 *
 * Asserts:
 *   (a) every approved copy string from #2151 comment 5821408557 is
 *       present verbatim on the rendered page (H1, subhead, 3 benefit
 *       bullets, agreement checkbox text, CTA, fee sentence, D-266
 *       disclaimer, post-submit confirmation).
 *   (b) the short field set (name/email/phone/agency + checkbox, no
 *       visible password) with field labels "Name / Email / Phone /
 *       Agency".
 *   (c) NEGATIVE CONTROL: loading without submitting makes zero
 *       register_partner calls.
 *   (d) a full submit calls register_partner with p_agent_type
 *       ="insurance_agent", p_company from the Agency field, and
 *       p_funnel_id="ins-1" derived from utm_campaign=ins-1 on the ad
 *       URL (no explicit ?funnel_id= needed -- same P-2 fallback
 *       regex partner-insurance.html already uses).
 *
 * Technique: extract the REAL inline <script> source (never a
 * hand-retyped copy) and run it in a `vm` context behind a minimal DOM/
 * Auth/Supabase/CONFIG shim, then drive the real submit handler exactly
 * as a browser would -- same technique as tests/gh2154-p1-short-signup.mjs.
 *
 * Run: node tests/gh2151-ins1-page.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const PAGE_FILE = 'ins-1.html';

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}
function failWithReason(label, reason) {
  console.log('FAIL: ' + label + ' -- ' + reason);
  fail++;
}

// ── (a) approved copy, verbatim (#2151 comment 5821408557) ──────────────
const APPROVED_STRINGS = [
  ['H1', 'Keep Your Client After a Storm Claim'],
  ['Subhead', 'Send your policyholders to Otter Quotes for fast, competing repair bids — you stay their trusted agent, not a canvassing contractor.'],
  ['Bullet 1', 'Your client gets multiple contractor bids without a door-knocker showing up first.'],
  ['Bullet 2', 'Earn $200 when a referred job of $10,000+ completes.'],
  ['Bullet 3', 'Track every referral from your phone, in real time.'],
  ['CTA', 'Get My Referral Link'],
  ['Agreement checkbox text', "I agree to Otter Quotes's Partner Terms"],
  ['Fee sentence (D-301/D-305, verbatim)', '$200 when a homeowner you refer completes a project of $10,000 or more. $50 on the same terms for referrals from partners you recruit.'],
  ['D-266 disclaimer (verbatim)', 'Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.'],
  ['Post-submit confirmation', "Install the Otter Quotes partner app, sign in with the account you just created, and your referral link will be waiting inside."],
];

const html = fs.readFileSync(path.join(repoRoot, PAGE_FILE), 'utf8');

// Verbatim-copy match, tolerant of inline markup (e.g. the agreement
// checkbox's "Partner Terms" link splitting the sentence with a <a> tag)
// and incidental whitespace -- strip tags and collapse whitespace on both
// sides before comparing, so this is still a real verbatim-text check, not
// a fuzzy one.
function normalize(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
const normalizedHtml = normalize(html);

for (const [label, text] of APPROVED_STRINGS) {
  ok(normalizedHtml.includes(normalize(text)), 'ins-1.html (a): approved copy present verbatim -- ' + label);
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
  failWithReason('ins-1.html (b): form present with the short field set', 'no <form>...</form> found');
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
  ok(passwordFields.length === 0, 'ins-1.html (b): NO visible password field on the signup step');
  ok(inputs.some((i) => i.id === 'fullName'), 'ins-1.html (b): Name field present (#fullName)');
  ok(inputs.some((i) => i.id === 'email'), 'ins-1.html (b): Email field present (#email)');
  ok(inputs.some((i) => i.id === 'phone'), 'ins-1.html (b): Phone field present (#phone)');
  ok(inputs.some((i) => i.id === 'company'), 'ins-1.html (b): Agency field present (#company)');
  ok(inputs.some((i) => i.type === 'checkbox'), 'ins-1.html (b): agreement checkbox present');
}
ok(/<label for="fullName"[^>]*>Name<\/label>/.test(html), 'ins-1.html (b): field label "Name" (not "Full Name")');
ok(/<label for="phone"[^>]*>Phone<\/label>/.test(html), 'ins-1.html (b): field label "Phone" (not "Phone Number")');
ok(/<label for="company"[^>]*>Agency<\/label>/.test(html), 'ins-1.html (b): field label "Agency" (not "Brokerage / Agency Name")');

// ── (c)/(d) dynamic checks -- run the REAL page script in a vm ──────────

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
        return Promise.resolve({ data: { id: 'gh2151-ins1-test-id', unique_code: 'TESTCODE123' }, error: null });
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
    signUpWithPassword: async () => ({ session: null, user: { id: 'gh2151-ins1-test-user-id' } }),
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

// (c) NEGATIVE CONTROL: an ad-URL load with utm_campaign=ins-1, no submit -> zero calls.
const AD_QS = '?utm_source=meta&utm_medium=paid_social&utm_campaign=ins-1&utm_content=creative1';
{
  const run = runPageScript(AD_QS);
  if (run.setupError) {
    failWithReason('ins-1.html (c) NEGATIVE CONTROL: loading without submitting makes zero register_partner calls', run.setupError);
  } else {
    const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
    ok(calls.length === 0, 'ins-1.html (c) NEGATIVE CONTROL: loading the page and not submitting makes zero register_partner calls');
  }
}

// (d) full submit -- p_funnel_id="ins-1" derived from utm_campaign=ins-1, p_agent_type="insurance_agent".
{
  const run = runPageScript(AD_QS);
  if (run.setupError) {
    failWithReason('ins-1.html (d): submitting calls register_partner with p_funnel_id="ins-1" and p_agent_type="insurance_agent"', run.setupError);
  } else {
    try {
      await submitForm(run, 'insuranceAgentForm', {
        fullName: 'Jane Test',
        email: 'gh2151-ins1-test@example.invalid',
        phone: '3175551234',
        company: 'Test Agency',
        agreeToTerms: true,
      });
      const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
      ok(calls.length === 1, 'ins-1.html (d): register_partner is called exactly once on a filled, agreed-to submit -- got ' + calls.length + ' call(s)');
      const params = calls[0] ? calls[0].params || {} : {};
      ok(params.p_funnel_id === 'ins-1', 'ins-1.html (d): p_funnel_id="ins-1" is passed (derived from utm_campaign) -- got ' + JSON.stringify(params.p_funnel_id));
      ok(params.p_utm_campaign === 'ins-1', 'ins-1.html (d): p_utm_campaign="ins-1" is passed -- got ' + JSON.stringify(params.p_utm_campaign));
      ok(params.p_agent_type === 'insurance_agent', 'ins-1.html (d): p_agent_type="insurance_agent" is passed -- got ' + JSON.stringify(params.p_agent_type));
      ok(params.p_company === 'Test Agency', 'ins-1.html (d): p_company (Agency field) is passed -- got ' + JSON.stringify(params.p_company));
    } catch (e) {
      failWithReason('ins-1.html (d): submitting calls register_partner with p_funnel_id="ins-1" and p_agent_type="insurance_agent"', e.message);
    }
  }
}

console.log('');
console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
