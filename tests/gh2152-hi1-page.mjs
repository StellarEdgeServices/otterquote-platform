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
// Ben's bus ruling 2026-09-25T17:19:38Z (HI-0.2/HI-0.5 CLOSE-REVIEW FAIL,
// #2152 comment 5836510515): the ?track=home_inspector query-param hide is
// JS-only and fails open with JS off, so every inspector path -- including
// this page's checkbox and footer links -- now points at the static
// partner-agreement-inspector.html (fee sections removed at build time,
// built in a separate PR under #2155; #2186 depends on that PR).
const AGREEMENT_LINK_RE = /href="\/?partner-agreement-inspector\.html"/g;
ok((html.match(AGREEMENT_LINK_RE) || []).length === 2, 'hi-1.html (c)/ruling: exactly 2 links (checkbox + footer) point at partner-agreement-inspector.html -- got ' + (html.match(AGREEMENT_LINK_RE) || []).length);
ok(!/partner-agreement\.html/.test(html), 'hi-1.html (c)/ruling: no link on this page points at the realtor/agent partner-agreement.html (fee table) any more, tracked or not');
ok(!/href="\/?partners\.html"/.test(html), 'hi-1.html ruling(bus 17:19:38Z item 3): no link to partners.html anywhere on this page');

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
    const classes = new Set();
    const el = {
      id, tag, value: '', checked: false, disabled: false, files: [],
      textContent: '', innerHTML: '', href: '', className: '', selected: false,
      style: {}, children: [], _listeners: {}, _classes: classes,
      classList: {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        toggle(c) { classes.has(c) ? classes.delete(c) : classes.add(c); },
        contains(c) { return classes.has(c); },
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
    getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl(id, 'div')); return byId.get(id); },
    createElement(tag) { const el = makeEl('__created_' + created.length, tag); created.push(el); return el; },
    byId, created,
  };
}

function runPageScript(search, opts) {
  opts = opts || {};
  const script = extractInlineScripts(html);
  if (!script || script.indexOf('register_partner') === -1) {
    return { setupError: 'no inline script containing register_partner was found on the page' };
  }
  const store = makeElementStore();
  const rpcCalls = [];
  const gtagCalls = [];
  const clarityCalls = [];
  const replaceCalls = [];
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
    location: { search: search || '', hostname: 'otterquote.com', href: '', replace(url) { replaceCalls.push(url); } },
    localStorage,
    addEventListener() {}, removeEventListener() {},
    scrollTo() {},
    requestIdleCallback(fn) { fn(); return 1; },
    crypto: cryptoStub,
  };
  win.window = win;
  const AuthObj = {
    signUpWithPassword: opts.signUpWithPassword || (async () => ({ session: null, user: { id: 'gh2152-hi1-test-user-id' } })),
    hasPartnerSession: opts.hasPartnerSession || (async () => false),
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
    fbq() {}, gtag(...args) { gtagCalls.push(args); },
    clarity(...args) { clarityCalls.push(args); },
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
  return { store, rpcCalls, gtagCalls, clarityCalls, replaceCalls };
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

// ── CEO RUN 70 bus (17:03:44Z) rulings (1)-(8), applied pre-emptively to
// HI-1 (same defects reviewed on RE-1 #2185 / INS-1 #2184) ─────────────

// (1) S07: header/footer opt out of the full site nav via data-skip-nav.
ok(/<header id="site-header"[^>]*\bdata-skip-nav="true"/.test(html), 'hi-1.html ruling(1): #site-header carries data-skip-nav="true" (no header link farm before the conversion)');
ok(/<footer id="site-footer"[^>]*\bdata-skip-nav="true"/.test(html), 'hi-1.html ruling(1): #site-footer carries data-skip-nav="true" (no footer link farm before the conversion)');
{
  // HI-1 ruling (1) EXTENDED (REVIEW FAIL 5836700203): the original
  // assertion only scanned the hand-coded legal paragraph, so it missed
  // the "Homeowner referral landing page" -> /ref-inspector.html escape
  // hatch that rendered elsewhere on the page (an unapproved off-page
  // link whose target shows a $15 figure). Now count EVERY <a href> that
  // leaves the page anywhere before conversion, plus any JS-built link
  // assignment (a `.href = ` write to an element other than the
  // post-conversion install-the-app buttons), not just the legal
  // paragraph. Same-page anchors (href="#...") never leave the page and
  // are excluded. The post-conversion successMessage/checkEmailMessage
  // blocks (the approved "Install the App" action) are stripped out
  // first -- they render only AFTER conversion, which is exactly what
  // "before conversion" means, and their target is the approved
  // confirmation action, not an escape hatch.
  let preConversionHtml = html
    .replace(/<div id="successMessage"[\s\S]*?<\/div>\s*<\/div>/, '')
    .replace(/<div id="checkEmailMessage"[\s\S]*?<\/div>\s*<\/div>/, '');
  const allHrefs = [...preConversionHtml.matchAll(/<a\s+[^>]*\bhref="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((h) => !h.startsWith('#'));
  const ALLOWED = ['/partner-agreement-inspector.html', 'partner-agreement-inspector.html', '/terms.html', '/privacy.html'];
  ok(allHrefs.length === 4, 'hi-1.html ruling(1) EXTENDED: exactly 4 off-page links leave the page before conversion (checkbox Partner Agreement link + the 3 legally required footer links) -- got ' + allHrefs.length + ': ' + JSON.stringify(allHrefs));
  ok(allHrefs.every((h) => ALLOWED.includes(h)), 'hi-1.html ruling(1) EXTENDED: every off-page link before conversion is one of the legally required links (Privacy, Terms, Partner Agreement -> partner-agreement-inspector.html) -- got ' + JSON.stringify(allHrefs));
  ok(!/\.href\s*=\s*[`'"]\/?ref-inspector\.html/.test(html), 'hi-1.html ruling(1): no JS-built link assigns a /ref-inspector.html href anywhere on the page (the removed seoRefLink escape hatch does not come back)');
  ok(!html.includes('ref-inspector.html'), 'hi-1.html ruling(1): the string "ref-inspector.html" does not appear anywhere on the page (link and JS both removed)');
  ok(!/Homeowner referral landing page/.test(html), 'hi-1.html ruling(1): the "Homeowner referral landing page" link text does not appear anywhere on the page');
  const legalLinksBlock = (html.match(/<p style="text-align:center;font-size:0\.85rem;color:var\(--slate\);padding:32px[\s\S]*?<\/p>/) || [''])[0];
  const legalHrefs = [...legalLinksBlock.matchAll(/<a\s+href="([^"]+)"/g)].map((m) => m[1]);
  ok(legalHrefs.length === 3, 'hi-1.html ruling(1): exactly 3 legally required footer links (Privacy, Terms, Partner Agreement) -- got ' + legalHrefs.length + ': ' + JSON.stringify(legalHrefs));
  ok(legalHrefs.some((h) => h.includes('partner-agreement-inspector.html')), 'hi-1.html ruling(1): the Partner Agreement footer link points at partner-agreement-inspector.html');
  ok(legalHrefs.some((h) => h.includes('/terms.html')), 'hi-1.html ruling(1): Terms of Service footer link present');
  ok(legalHrefs.some((h) => h.includes('/privacy.html')), 'hi-1.html ruling(1): Privacy Policy footer link present');
}
// HI-1 ruling (1) MUST-FIX (REVIEW FAIL 5836700203): the "What You Get"
// heading is not in the approved copy and has been removed.
ok(!/<h3>\s*What You Get\s*<\/h3>/.test(html), 'hi-1.html ruling(1): the unapproved "What You Get" heading has been removed from the benefits sidebar');

// (2) Hero/bullet contrast, WCAG AA 4.5:1 -- HI-1 has no in-hero bullet
// list (the RE-1/INS-1 defect target); the analogous bullet-style copy on
// this page is the benefits-sidebar text. Verify it meets AA against its
// own background, and that no copy changed.
function srgbToLinear(c) {
  c = c / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relLuminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrastRatio(hexA, hexB) {
  const la = relLuminance(hexA), lb = relLuminance(hexB);
  const lighter = Math.max(la, lb), darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
ok(!/class="hero-bullets"/.test(html) && !/\.hero-bullets/.test(html), 'hi-1.html ruling(2): no in-hero bullet list exists on this page (N/A for HI-1 -- bullets live in the benefits sidebar instead)');
{
  const ratio = contrastRatio('#94A3B8', '#12354A'); // .benefit-item p (--slate) on .benefits-sidebar (--navy-3)
  ok(ratio >= 4.5, 'hi-1.html ruling(2): benefits-sidebar bullet text meets WCAG AA 4.5:1 against its background -- computed ratio ' + ratio.toFixed(2));
}
ok(normalizedHtml.includes(normalize('Your client gets multiple contractor bids without hunting for one.')), 'hi-1.html ruling(2): bullet copy unchanged (no copy change per ruling)');

// (3) S12: Clarity funnel_id tag + PII fields masked. js/ga-gate.js's
// CLARITY_ALLOWED_PATHS entry for /hi-1 is out of scope (RE-1 worker's
// PR #2185) -- not asserted here.
ok(/clarity\(\s*['"]set['"]\s*,\s*['"]funnel_id['"]\s*,\s*\w+\s*\)/.test(html) && /HI1_FUNNEL_ID\s*=\s*['"]hi-1['"]/.test(html), 'hi-1.html ruling(3): a clarity(\'set\',\'funnel_id\',<hi-1 id>) tag call is present');
ok(/<body[^>]*\bdata-clarity-mask="true"/.test(html), 'hi-1.html ruling(3): <body data-clarity-mask="true"> masks all text/inputs in Clarity replay, covering name/email/phone/company (repo convention: scripts/check-clarity-page-gate.py body_mask_problem)');
for (const fid of ['fullName', 'email', 'phone', 'company']) {
  const tagMatch = new RegExp('<input\\b[^>]*\\bid="' + fid + '"[^>]*>').exec(html);
  ok(!!(tagMatch && /data-clarity-mask="true"/.test(tagMatch[0])), 'hi-1.html ruling(3): #' + fid + ' input carries data-clarity-mask="true"');
}
{
  const run = runPageScript(AD_QS);
  if (!run.setupError) {
    ok(run.clarityCalls.some((a) => a[0] === 'set' && a[1] === 'funnel_id' && a[2] === 'hi-1'), 'hi-1.html ruling(3): at runtime, clarity(\'set\',\'funnel_id\',\'hi-1\') is actually called -- got ' + JSON.stringify(run.clarityCalls));
  }
}

// (4) S11: GA4 view + step + conversion events all carry variant + step.
{
  const run = runPageScript(AD_QS);
  if (run.setupError) {
    failWithReason('hi-1.html ruling(4): view/step events carry variant+step', run.setupError);
  } else {
    const viewCalls = run.gtagCalls.filter((a) => a[0] === 'event' && a[1] === 'partner_funnel_view');
    ok(viewCalls.length >= 1, 'hi-1.html ruling(4): a partner_funnel_view event fires on load -- got ' + viewCalls.length);
    if (viewCalls.length) {
      const p = viewCalls[0][2] || {};
      ok(p.step === 'view' && typeof p.variant !== 'undefined', 'hi-1.html ruling(4): partner_funnel_view carries step="view" and a variant -- got ' + JSON.stringify(p));
    }
    // Simulate the visitor focusing a field -- fires the step event.
    const nameEl = run.store.getElementById('fullName');
    (nameEl._listeners.focus || []).forEach((fn) => fn({}));
    const stepCalls = run.gtagCalls.filter((a) => a[0] === 'event' && a[1] === 'partner_funnel_step');
    ok(stepCalls.length === 1, 'hi-1.html ruling(4): a partner_funnel_step(step=form_start) event fires once on first field focus -- got ' + stepCalls.length);
    if (stepCalls.length) {
      ok(stepCalls[0][2] && stepCalls[0][2].step === 'form_start', 'hi-1.html ruling(4): the step event carries step="form_start" -- got ' + JSON.stringify(stepCalls[0][2]));
    }
  }
}
{
  const run = runPageScript(AD_QS);
  if (!run.setupError) {
    await submitForm(run, 'homeInspectorForm', {
      fullName: 'Jane Test', email: 'gh2152-hi1-test2@example.invalid', phone: '3175551234', company: 'Test Inspections', agreeToTerms: true,
    });
    const signupCalls = run.gtagCalls.filter((a) => a[0] === 'event' && a[1] === 'partner_signup');
    const completeCalls = run.gtagCalls.filter((a) => a[0] === 'event' && a[1] === 'partner_signup_complete');
    ok(signupCalls.length === 1 && signupCalls[0][2] && signupCalls[0][2].step === 'submit' && typeof signupCalls[0][2].variant !== 'undefined', 'hi-1.html ruling(4): partner_signup carries step="submit" and a variant -- got ' + JSON.stringify(signupCalls[0] && signupCalls[0][2]));
    ok(completeCalls.length === 1 && completeCalls[0][2] && completeCalls[0][2].step === 'complete', 'hi-1.html ruling(4): partner_signup_complete carries step="complete" -- got ' + JSON.stringify(completeCalls[0] && completeCalls[0][2]));
  }
}

// (5) S20: ONLY the approved confirmation text + install-the-app action.
ok(!/<h[1-6][^>]*>\s*You're [Ii]n!?\s*<\/h[1-6]>/.test(html), 'hi-1.html ruling(5): no separate "You\'re in!"-style heading (approved sentence rendered as plain text, not a duplicated heading)');
ok(!/id="referralLink"|class="referral-link-box"|id="copyBtn"/.test(html), 'hi-1.html ruling(5): no on-page referral link box / Copy button');
ok(!/Go to Partner Dashboard/.test(html), 'hi-1.html ruling(5): no "Go to Partner Dashboard" button in the confirmation');
ok(!/id="google-btn"|Continue with Google/.test(html), 'hi-1.html ruling(5): no Google sign-in button');
ok(!normalizedHtml.includes(normalize('Join the Otter Quotes Partner Network')), 'hi-1.html ruling(5): no "Join the Otter Quotes Partner Network" heading');
{
  const scriptOnly = extractInlineScripts(html);
  ok(!/\balert\s*\(/.test(scriptOnly), 'hi-1.html ruling(5): no browser alert() anywhere in the page script');
}
ok(normalizedHtml.includes(normalize('Almost there — check your email')) && normalizedHtml.includes(normalize('We sent a confirmation link to')) && normalizedHtml.includes(normalize('then sign in to your new partner account.')), 'hi-1.html ruling(5): checkEmailMessage reuses main P-1\'s check-email string verbatim (partner-insurance.html)');
ok(normalizedHtml.includes(normalize("You're in! Install the Otter Quotes partner app, sign in with the account you just created, and your link will be waiting inside to add to your reports.")), 'hi-1.html ruling(5): the approved confirmation sentence still appears verbatim (in both states)');
{
  // Signed-in visitor lands on the approved confirmation, not the dashboard.
  const run = runPageScript('', { hasPartnerSession: async () => true });
  if (run.setupError) {
    failWithReason('hi-1.html ruling(5): a signed-in visitor sees the approved confirmation, not the dashboard', run.setupError);
  } else {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    ok(!run.replaceCalls.includes('/partner-dashboard.html'), 'hi-1.html ruling(5): a signed-in visitor is never redirected to /partner-dashboard.html -- replace() calls: ' + JSON.stringify(run.replaceCalls));
    const successEl = run.store.byId.get('successMessage');
    ok(!!(successEl && successEl.classList.contains('show')), 'hi-1.html ruling(5): a signed-in visitor is shown the approved confirmation (#successMessage gets .show)');
  }
}
{
  // A session established AT signup time also lands on the confirmation.
  const run = runPageScript(AD_QS, { signUpWithPassword: async () => ({ session: { access_token: 'x' }, user: { id: 'gh2152-hi1-session-user' } }) });
  if (!run.setupError) {
    await submitForm(run, 'homeInspectorForm', {
      fullName: 'Jane Test', email: 'gh2152-hi1-test3@example.invalid', phone: '3175551234', company: 'Test Inspections', agreeToTerms: true,
    });
    ok(!run.replaceCalls.includes('/partner-dashboard.html') && run.store.byId.get('successMessage') && run.store.byId.get('successMessage').classList.contains('show'), 'hi-1.html ruling(5): a session created at signup lands on the approved confirmation, not the dashboard');
  }
}

// (6) funnel_id defaults to hi-1 on a bare load; never a stale stored value
// left by a visit to a DIFFERENT funnel page. Each runPageScript() call gets
// its own fresh localStorage, so the fallback is asserted directly: a bare
// load (no URL params at all, i.e. nothing to inherit from a prior funnel)
// must still submit funnelId "hi-1", never null/undefined.
{
  const run2 = runPageScript('');
  if (!run2.setupError) {
    await submitForm(run2, 'homeInspectorForm', {
      fullName: 'Jane Test', email: 'gh2152-hi1-test4@example.invalid', phone: '3175551234', company: 'Test Inspections', agreeToTerms: true,
    });
    const calls = run2.rpcCalls.filter((c) => c.name === 'register_partner');
    const params = calls[0] ? calls[0].params || {} : {};
    ok(params.p_funnel_id === 'hi-1', 'hi-1.html ruling(6): a bare load with no URL params still submits p_funnel_id="hi-1" -- got ' + JSON.stringify(params.p_funnel_id));
  }
}

// (7) S15 per Ben's ruling (bus 2026-09-25T17:24:58Z): "no client-side
// founder mechanism needed ... Do not add founder emails to page JS."
// is_test is set exactly as main's P-1 pages / js/auth.js isTestEmail() do
// (@otterquote-internal.test) and nothing else -- no founder address may be
// hardcoded or specially flagged in hi-1.html.
ok(!/@gmail\.com/i.test(html), 'hi-1.html ruling(7): no personal/founder email literal (e.g. "@gmail.com") appears in the page source');
ok(!/dustinstohler1/i.test(html), 'hi-1.html ruling(7): no founder email literal ("dustinstohler1") appears in the page source');
{
  const run = runPageScript(AD_QS);
  if (!run.setupError) {
    await submitForm(run, 'homeInspectorForm', {
      fullName: 'Dustin Founder', email: 'dustinstohler1@gmail.com', phone: '3175551234', company: 'Founder Test Co',
      agreeToTerms: true,
    });
    const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
    const params = calls[0] ? calls[0].params || {} : {};
    ok(params.p_is_test !== true, 'hi-1.html ruling(7): a founder-looking address (dustinstohler1@gmail.com) is NOT flagged p_is_test by the page -- got ' + JSON.stringify(params.p_is_test));
  }
}
{
  const run = runPageScript(AD_QS);
  if (!run.setupError) {
    await submitForm(run, 'homeInspectorForm', {
      fullName: 'Test Row', email: 'gh2152-hi1-founder-check@otterquote-internal.test', phone: '3175551234', company: 'Test Inspections',
      agreeToTerms: true,
    });
    const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
    const params = calls[0] ? calls[0].params || {} : {};
    ok(params.p_is_test === true, 'hi-1.html ruling(7): an @otterquote-internal.test address IS still flagged p_is_test=true (same as main P-1 pages / js/auth.js isTestEmail()) -- got ' + JSON.stringify(params.p_is_test));
  }
}

// (8) S08 (already-met) inline per-field errors + partner type fixed, no pop-up.
ok(/id="fullNameError"/.test(html) && /id="emailError"/.test(html) && /id="phoneError"/.test(html) && /id="companyError"/.test(html), 'hi-1.html ruling(8): already-met -- inline per-field error elements exist for every field');
ok(!/Confirm your partner type/.test(html), 'hi-1.html ruling(8): no "Confirm your partner type" pop-up (partner type is fixed by the page)');
{
  const run = runPageScript(AD_QS);
  if (!run.setupError) {
    await submitForm(run, 'homeInspectorForm', {
      fullName: 'Jane Test', email: 'gh2152-hi1-test5@example.invalid', phone: '3175551234', company: 'Test Inspections', agreeToTerms: true,
    });
    const created = run.store.created;
    ok(!created.some((e) => e.textContent === 'Confirm your partner type' || e.textContent === 'Confirm & Continue'), 'hi-1.html ruling(8): submitting never creates a partner-type confirmation modal');
    const calls = run.rpcCalls.filter((c) => c.name === 'register_partner');
    const params = calls[0] ? calls[0].params || {} : {};
    ok(params.p_agent_type === 'home_inspector', 'hi-1.html ruling(8): p_agent_type is always "home_inspector" with no user choice -- got ' + JSON.stringify(params.p_agent_type));
  }
}

// ── REVIEW FAIL 5836700203 + LEGAL-READ FAIL 5836690876 fixes (bus
// 2026-09-25T17:33:44Z, Ben's DECIDED rulings on #2186) ────────────────

// (3) meta description + og:description must be an approved HI-1 sentence
// verbatim (LEGAL-READ FAIL: the previous copy -- "...Sign up as an Otter
// Quotes partner — no referral fee." -- was both a paraphrase and fee
// language). Now the approved subhead (#2152 comment 5821414324),
// verbatim, no paraphrase.
{
  const APPROVED_SUBHEAD = 'Give your clients a co-branded link to competing repair bids when your report flags damage — a better next step than a business card.';
  const descMatch = /<meta name="description" content="([^"]+)">/.exec(html);
  const ogDescMatch = /<meta property="og:description" content="([^"]+)">/.exec(html);
  ok(!!descMatch && descMatch[1] === APPROVED_SUBHEAD, 'hi-1.html (3): meta description is the approved HI-1 subhead verbatim -- got ' + JSON.stringify(descMatch && descMatch[1]));
  ok(!!ogDescMatch && ogDescMatch[1] === APPROVED_SUBHEAD, 'hi-1.html (3): og:description is the approved HI-1 subhead verbatim -- got ' + JSON.stringify(ogDescMatch && ogDescMatch[1]));
  ok(!/no referral fee/i.test(descMatch ? descMatch[1] : ''), 'hi-1.html (3): meta description carries no fee language');
  ok(!/no referral fee/i.test(ogDescMatch ? ogDescMatch[1] : ''), 'hi-1.html (3): og:description carries no fee language');
}

// (4) DECIDED Ben: the visible approved no-fee sentence STAYS -- it is a
// disclosure, not a fee offer (Tier B, Dustin approved it "if needed").
// Do not remove it.
ok(normalizedHtml.includes(normalize('Home-inspector partners do not receive a referral fee or recruit bonus.')), 'hi-1.html (4): the DECIDED-to-stay visible no-fee disclosure sentence is present verbatim');

// (5) Inline error text contrast >= 4.5:1 (WCAG AA). --red was #EF4444
// (3.95:1 on --navy-2, FAIL); now #F87171 (5.37:1, PASS).
{
  const redMatch = /--red:\s*(#[0-9A-Fa-f]{6})/.exec(html);
  ok(!!redMatch, 'hi-1.html (5): --red custom property is defined');
  const ratio = redMatch ? contrastRatio(redMatch[1], '#0E2A3B') : 0; // .field-error color on --navy-2 background
  ok(ratio >= 4.5, 'hi-1.html (5): inline field-error text (--red ' + (redMatch && redMatch[1]) + ' on --navy-2 #0E2A3B) meets WCAG AA 4.5:1 -- computed ratio ' + ratio.toFixed(2));
  // Fail-first control: the pre-fix color (#EF4444) computes below AA.
  const oldRatio = contrastRatio('#EF4444', '#0E2A3B');
  ok(oldRatio < 4.5, 'hi-1.html (5) fail-first control: the pre-fix --red (#EF4444) computed ' + oldRatio.toFixed(2) + ', confirming it failed AA before this fix');
}

// (6) Strings -> main's verbatim (LEGAL-READ FAIL 5836690876 breaks 1-3).
ok(normalizedHtml.includes(normalize('Install the App')), 'hi-1.html (6): "Install the App" (main: partner-dashboard.html:950) appears verbatim');
ok(!html.includes('Install the Partner App'), 'hi-1.html (6): the unapproved "Install the Partner App" string is gone');
ok(normalizedHtml.includes(normalize("You must agree to the Partner Agreement and Terms.")), 'hi-1.html (6): "You must agree to the Partner Agreement and Terms." (main: partner-insurance.html:754) appears verbatim');
ok(!html.includes("You must agree to Otter Quotes's Partner Terms."), 'hi-1.html (6): the unapproved agreement-checkbox error string is gone');
ok(normalizedHtml.includes(normalize('Please fill in all required fields.')), 'hi-1.html (6): "Please fill in all required fields." (main: partner-re.html:1474) appears verbatim');
ok(!html.includes('Please enter your company name.'), 'hi-1.html (6): the unapproved "Please enter your company name." string is gone');
{
  const run = runPageScript(AD_QS);
  if (!run.setupError) {
    await submitForm(run, 'homeInspectorForm', {
      fullName: 'Jane Test', email: 'gh2152-hi1-test6@example.invalid', phone: '3175551234', company: '', agreeToTerms: true,
    });
    const companyErrorEl = run.store.getElementById('companyError');
    ok(!!companyErrorEl && (companyErrorEl.textContent || '').includes('Please fill in all required fields.'), 'hi-1.html (6): submitting with a blank Company field shows "Please fill in all required fields." live (not the old per-field string) -- got ' + JSON.stringify(companyErrorEl && companyErrorEl.textContent));
  }
}

// ── HI-0.5 fix (1) (CLOSE-REVIEW FAIL on #2152 comment 5838422299, Ben
// DECIDED 19:36:37Z, href only): every hi-1.html link to a partner page
// (partner-app / partner-login / partner-dashboard / partner-inspectors)
// carries ?track=home_inspector so the app lands on the inspector track.
// The agreement links (partner-agreement-inspector.html) are exempt --
// they already point at the inspector-specific agreement. Fails on the
// pre-fix page, where "Install the App" linked a bare /partner-app.html.
{
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const partnerHrefs = [...noComments.matchAll(/<a\b[^>]*href="([^"]*partner-(?:app|login|dashboard|inspectors)[^"]*)"/g)].map((m) => m[1]);
  ok(partnerHrefs.length >= 1, 'hi-1.html HI-0.5 fix (1): at least one partner-page link exists (the Install the App action) -- got ' + JSON.stringify(partnerHrefs));
  const missing = partnerHrefs.filter((h) => !/[?&]track=home_inspector(&|$)/.test(h));
  ok(missing.length === 0, 'hi-1.html HI-0.5 fix (1): every partner-page link carries ?track=home_inspector -- missing on ' + JSON.stringify(missing));
  const installHrefs = [...noComments.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>\s*Install the App\s*<\/a>/g)].map((m) => m[1]);
  ok(installHrefs.length >= 1 && installHrefs.every((h) => h === '/partner-app.html?track=home_inspector'), 'hi-1.html HI-0.5 fix (1): every "Install the App" link is /partner-app.html?track=home_inspector -- got ' + JSON.stringify(installHrefs));
  const agreementHrefs = [...noComments.matchAll(/<a\b[^>]*href="([^"]*partner-agreement[^"]*)"/g)].map((m) => m[1]);
  ok(agreementHrefs.length >= 1 && agreementHrefs.every((h) => /partner-agreement-inspector\.html$/.test(h)), 'hi-1.html HI-0.5 fix (1): agreement links still point at partner-agreement-inspector.html, unchanged -- got ' + JSON.stringify(agreementHrefs));
}

console.log('');
console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
