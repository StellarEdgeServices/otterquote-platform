/**
 * gh-2361 (CRO47 spec section 3, "PR b") -- the partner trust header on
 * re-1.html / ins-1.html / hi-1.html.
 *
 * Rulings binding on this test (Sloane, CRO RUN 47, on #2361):
 *   Q4  partner pages get logo + wordmark "Otter Quotes" + photo slot ONLY.
 *       No new one-liner. No "free, no obligation" (that is the homeowner price).
 *   Q1  the photo slot ships HIDDEN: no placeholder / stock / AI image, no src.
 *   the logo is an existing asset, a NON-link static element, inside the
 *   existing empty <header id="site-header" ... data-skip-nav="true">.
 *
 * Tests (spec 3.3), all against the REAL page files served over HTTP into a
 * REAL headless Chromium (Playwright), so the phone claim is a browser
 * measurement and not a source grep:
 *   P1  390x744 in a Facebook in-app UA: logo (naturalWidth>0), wordmark, no
 *       link around the logo, no link/button/nav/support bubble in the header,
 *       first form input top < 744, zero CLS, photo slot hidden with no request.
 *   P2  fields + order + ids + required unchanged.
 *   P3  legal text whole and unmoved (re-1/ins-1 fee sentence + D-266 after the
 *       submit button in DOM order; hi-1 no-fee statement and NO D-266/$200).
 *   P4  events + attribution through a mocked signup (real page script, real
 *       Auth, stub supabase client). hi-1 view/step events are reported as a
 *       FINDING when absent; this PR does not fix them.
 *   P5  terms link unchanged.
 *   PN1 remove data-skip-nav from the header -> the "no nav render" check goes RED.
 *   PN2 alter one character of the D-266 disclaimer -> P3 goes RED.
 *   PN3 wrap the logo in an <a> -> P1 goes RED.
 *   PN4 the snippet must not live in shared JS/CSS: /start, partner-re.html and
 *       partner-insurance.html render without it; injecting it into css/nav.css
 *       makes the check go RED.
 * Every PN mutation is applied at SERVE time (the file on disk is never
 * touched) and the mutation target MUST exist; a missing target is a FAIL, so a
 * PN cannot pass vacuously on a page that lacks the header.
 *
 * Run: node tests/cro47-trust-partner.mjs
 * Playwright resolution (no install on the host): tests/e2e/node_modules
 * (`npm ci` in tests/e2e, as CI does), or PW_MODULE_DIR=<dir containing
 * package.json + node_modules/playwright>.
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const pwDir = process.env.PW_MODULE_DIR || path.join(repoRoot, 'tests', 'e2e');
const { chromium } = createRequire(path.join(pwDir, 'package.json'))('playwright');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

const FB_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/450.0]';
const D266 = 'Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.';
const FEE_SENTENCE = '$200 when a homeowner you refer completes a project of $10,000 or more. $50 on the same terms for referrals from partners you recruit.';
const NO_FEE = 'Home-inspector partners do not receive a referral fee or recruit bonus.';
// The logo alt text is reused verbatim from js/nav.js (the site's own header logo).
const LOGO_ALT = 'Otter Quotes';
const LOGO_SRC = '/img/brand-assets/otter-quotes-icon-512.png';

const PAGES = [
  {
    file: 're-1.html', funnel: 're-1', form: '#partner-form', submit: '#submit-btn', cta: 'Get My Referral Link',
    fields: [['name', 'text'], ['email', 'email'], ['phone', 'tel'], ['brokerage', 'text']], terms: 'terms',
    fill: { name: 'Jane Test', email: 'cro47-re1@otterquote-internal.test', phone: '3175551234', brokerage: 'Test Realty Co' },
    agreement: 'partner-agreement.html', legal: 'fee+d266', agentType: 're_agent',
    events: ['partner_signup_view', 'partner_signup_step', 'partner_signup', 'partner_signup_complete'],
    viewEvent: 'partner_signup_view', stepEvent: 'partner_signup_step', stepOnFocus: false,
  },
  {
    file: 'ins-1.html', funnel: 'ins-1', form: 'form:has(#agreeToTerms)', submit: 'form:has(#agreeToTerms) button[type=submit]', cta: 'Get My Referral Link',
    fields: [['fullName', 'text'], ['email', 'email'], ['phone', 'tel'], ['company', 'text']], terms: 'agreeToTerms',
    fill: { fullName: 'Jane Test', email: 'cro47-ins1@otterquote-internal.test', phone: '3175551234', company: 'Test Agency' },
    agreement: '/partner-agreement.html', legal: 'fee+d266', agentType: 'insurance_agent',
    events: ['partner_view', 'partner_form_start', 'partner_signup', 'partner_signup_complete'],
    viewEvent: 'partner_view', stepEvent: 'partner_form_start', stepOnFocus: true,
  },
  {
    file: 'hi-1.html', funnel: 'hi-1', form: '#homeInspectorForm', submit: '#homeInspectorForm button[type=submit]', cta: 'Get My Link',
    fields: [['fullName', 'text'], ['email', 'email'], ['phone', 'tel'], ['company', 'text']], terms: 'agreeToTerms',
    fill: { fullName: 'Jane Test', email: 'cro47-hi1@otterquote-internal.test', phone: '3175551234', company: 'Test Inspections' },
    agreement: 'partner-agreement-inspector.html', legal: 'nofee', agentType: 'home_inspector',
    events: ['partner_funnel_view', 'partner_funnel_step', 'partner_signup', 'partner_signup_complete'],
    viewEvent: 'partner_funnel_view', stepEvent: 'partner_funnel_step', stepOnFocus: true,
  },
];

// ── static file server with serve-time mutations ────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json' };
const mutations = new Map(); // url path -> (text) => text
const requested = []; // every path the browser asked this server for
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  requested.push('/' + rel);
  const fp = path.join(repoRoot, rel);
  if (!fp.startsWith(repoRoot) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  const ext = path.extname(fp).toLowerCase();
  let body = fs.readFileSync(fp);
  const mut = mutations.get('/' + rel);
  if (mut) body = Buffer.from(mut(body.toString('utf8')), 'utf8');
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port;

// Stub supabase client: real page script + real Auth run against it.
const SUPABASE_STUB = `
(function () {
  window.__oqRpcCalls = [];
  function chain(result) {
    var p = new Proxy(function () {}, {
      get: function (_t, k) {
        if (k === 'then') return function (res) { return Promise.resolve(result).then(res); };
        return function () { return p; };
      },
      apply: function () { return p; }
    });
    return p;
  }
  var client = {
    auth: {
      signUp: function () { return Promise.resolve({ data: { user: { id: 'cro47-user' }, session: null }, error: null }); },
      getSession: function () { return Promise.resolve({ data: { session: null }, error: null }); },
      getUser: function () { return Promise.resolve({ data: { user: null }, error: null }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
      updateUser: function () { return Promise.resolve({ data: {}, error: null }); },
      signOut: function () { return Promise.resolve({ error: null }); }
    },
    rpc: function (name, args) {
      window.__oqRpcCalls.push({ name: name, args: args });
      if (name === 'register_partner') return Promise.resolve({ data: { unique_code: 'CRO47CODE' }, error: null });
      return chain({ data: null, error: null });
    },
    from: function () { return chain({ data: null, error: null }); }
  };
  window.supabase = { createClient: function () { return client; } };
})();`;

const browser = await chromium.launch();

function newContext(extra) {
  return browser.newContext({ viewport: { width: 390, height: 744 }, userAgent: FB_UA, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...extra });
}

async function loadPage(context, url, { stub = false } = {}) {
  const page = await context.newPage();
  // Hermetic: nothing leaves localhost.
  await page.route((u) => !u.href.startsWith(BASE), (r) => r.abort());
  await page.addInitScript(() => {
    window.__cls = 0;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    } catch (e) {}
  });
  if (stub) await page.addInitScript(SUPABASE_STUB);
  await page.goto(BASE + url, { waitUntil: 'load' });
  await page.waitForTimeout(1500); // let js/nav.js (which would build a header if not skipped) and css/nav.css land
  return page;
}

// ── the per-page checks, evaluated in the browser. Returns { label: boolean } ──
async function pageChecks(spec, mutate = {}) {
  const url = '/' + spec.file;
  mutations.clear();
  for (const [p, fn] of Object.entries(mutate)) mutations.set(p, fn);
  requested.length = 0;
  const ctx = await newContext();
  const page = await loadPage(ctx, url + '?utm_source=facebook&utm_medium=paid&utm_campaign=' + spec.funnel + '&fbclid=REALISH');
  const r = await page.evaluate((s) => {
    const q = (sel) => document.querySelector(sel);
    const hdr = q('#site-header');
    const logo = hdr && hdr.querySelector('img[src$="otter-quotes-icon-512.png"]');
    const wordmark = hdr && Array.from(hdr.querySelectorAll('*')).find((e) => e.children.length === 0 && e.textContent.trim() === 'Otter Quotes');
    const photo = q('#oqTrustPhoto');
    const form = q(s.form);
    const firstInput = form && form.querySelector('input');
    const vis = (e) => { if (!e) return false; const cs = getComputedStyle(e); const b = e.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0; };
    const hb = hdr ? hdr.getBoundingClientRect() : null;
    return {
      hasHeader: !!hdr,
      skipAttr: !!hdr && hdr.getAttribute('data-skip-nav') === 'true',
      logoPresent: !!logo,
      logoLoaded: !!logo && logo.naturalWidth > 0,
      logoAlt: logo ? logo.getAttribute('alt') : null,
      logoVisible: vis(logo),
      logoInAnchor: !!logo && !!logo.closest('a'),
      wordmarkVisible: vis(wordmark),
      headerAnchors: hdr ? hdr.querySelectorAll('a').length : -1,
      headerControls: hdr ? hdr.querySelectorAll('a,button,input,select,textarea,[onclick],[role=button],[role=link]').length : -1,
      navRendered: !!q('.nav-inner') || !!q('#site-header .nav-links') || !!q('#support-fab') || !!q('#site-footer .footer-inner'),
      headerNavChildren: hdr ? hdr.querySelectorAll('nav,.nav-inner,.nav-links').length : -1,
      photoExists: !!photo,
      photoHidden: !!photo && (photo.hasAttribute('hidden') && !vis(photo)),
      photoSrc: photo ? (photo.getAttribute('src') || '') : null,
      firstInputTop: firstInput ? Math.round(firstInput.getBoundingClientRect().top) : null,
      h1Top: q('h1') ? Math.round(q('h1').getBoundingClientRect().top) : null,
      headerH: hb ? Math.round(hb.height) : null,
      cls: window.__cls,
      ids: form ? Array.from(form.querySelectorAll('input')).map((i) => i.id + '|' + i.type + '|' + (i.required ? 'req' : 'opt')) : [],
      docText: document.body.innerText,
      headerText: hdr ? hdr.innerText.trim() : '',
      hasFreeNoOblig: /free,? (with )?no obligation/i.test(hdr ? hdr.innerText : ''),
    };
  }, spec);
  const html = await page.content();
  const photoRequested = requested.some((p) => /dustin|team\//i.test(p));
  const staticHtml = mutations.has(url) ? mutations.get(url)(fs.readFileSync(path.join(repoRoot, spec.file), 'utf8')) : fs.readFileSync(path.join(repoRoot, spec.file), 'utf8');
  await ctx.close();

  const res = {};
  res['P1 header has logo image (existing asset ' + LOGO_SRC + ', naturalWidth>0)'] = r.logoPresent && r.logoLoaded && r.logoVisible;
  res['P1 logo alt text reused verbatim from js/nav.js ("' + LOGO_ALT + '")'] = r.logoAlt === LOGO_ALT;
  res['P1 wordmark "Otter Quotes" visible in header'] = r.wordmarkVisible;
  res['P1 logo is a non-link (no <a> ancestor, zero links/controls in header)'] = r.logoPresent && !r.logoInAnchor && r.headerAnchors === 0 && r.headerControls === 0;
  res['P1 header text is exactly the wordmark (no new copy, no "free, no obligation")'] = r.headerText === 'Otter Quotes' && !r.hasFreeNoOblig;
  res['P1 no nav header / footer link farm / support bubble rendered (data-skip-nav honoured)'] = r.skipAttr && !r.navRendered && r.headerNavChildren === 0;
  res['P1 first form input top < 744 (form reachable on the first screen; got ' + r.firstInputTop + ', h1 top ' + r.h1Top + ', header height ' + r.headerH + ')'] = r.firstInputTop !== null && r.firstInputTop < 744;
  res['P1 zero CLS (got ' + r.cls + ')'] = r.cls === 0;
  res['P1 photo slot #oqTrustPhoto present, HIDDEN, no src, nothing fetched for it'] = r.photoExists && r.photoHidden && r.photoSrc === '' && !photoRequested;
  res['P2 field ids/types/required and order unchanged'] = JSON.stringify(r.ids) === JSON.stringify([...spec.fields.map(([id, t]) => id + '|' + t + '|req'), spec.terms + '|checkbox|req']);
  res['P5 terms link -> ' + spec.agreement] = new RegExp('href="' + spec.agreement.replace(/[.\/]/g, '\\$&') + '"').test(staticHtml);
  res['P2 submit CTA text "' + spec.cta + '" unchanged'] = new RegExp('>\\s*' + spec.cta + '\\s*<').test(staticHtml);
  // P3 legal text, on the static source (byte-identical, DOM order after the button)
  const btnAt = staticHtml.search(new RegExp('>\\s*' + spec.cta + '\\s*</button>'));
  if (spec.legal === 'fee+d266') {
    const feeAt = staticHtml.indexOf(FEE_SENTENCE), d266At = staticHtml.indexOf(D266);
    res['P3 fee sentence byte-identical and after the submit button'] = feeAt > btnAt && btnAt > -1;
    res['P3 D-266 disclaimer byte-identical, once, after fee sentence, after the button'] = d266At > feeAt && feeAt > -1 && staticHtml.split(D266).length === 2;
  } else {
    const nfAt = staticHtml.indexOf(NO_FEE);
    res['P3 hi-1 no-fee statement byte-identical, after the submit button'] = nfAt > btnAt && btnAt > -1;
    res['P3 hi-1 has NO D-266 disclaimer and NO $200 sentence (D-333)'] = !/lawful for you to accept referral fees/.test(r.docText) && !/\$200/.test(r.docText);
  }
  return res;
}

// ── run: P1/P2/P3/P5 on the shipped pages ───────────────────────────────────
for (const spec of PAGES) {
  const res = await pageChecks(spec);
  for (const [label, v] of Object.entries(res)) ok(v, spec.file + ' ' + label);
}

// ── P4 events + attribution, real script, stub supabase ─────────────────────
for (const spec of PAGES) {
  mutations.clear();
  const ctx = await newContext();
  const page = await loadPage(ctx, '/' + spec.file + '?utm_source=facebook&utm_medium=paid&utm_campaign=' + spec.funnel + '&fbclid=REALISH', { stub: true });
  const names = async () => page.evaluate(() => (window.dataLayer || []).filter((a) => a && a[0] === 'event').map((a) => a[1]));
  const onLoad = await names();
  ok(onLoad.includes(spec.viewEvent), spec.file + ' P4 ' + spec.viewEvent + ' fires on load -- got ' + JSON.stringify(onLoad));
  const first = spec.fields[0][0];
  await page.focus('#' + first);
  for (const [id] of spec.fields) await page.fill('#' + id, spec.fill[id]);
  await page.check('#' + spec.terms);
  await page.click(spec.submit);
  await page.waitForTimeout(2500);
  const all = await names();
  for (const ev of spec.events) {
    const present = all.includes(ev);
    if (!present && spec.file === 'hi-1.html' && (ev === spec.viewEvent || ev === spec.stepEvent)) {
      console.log('FINDING: hi-1.html ' + ev + ' did NOT fire in the mocked signup (spec 3.3 P4: reported, not fixed here) -- got ' + JSON.stringify(all));
    }
    ok(present, spec.file + ' P4 ' + ev + ' fires in the mocked signup -- got ' + JSON.stringify(all));
  }
  const calls = await page.evaluate(() => window.__oqRpcCalls.filter((c) => c.name === 'register_partner'));
  const a = calls[0] ? calls[0].args : {};
  ok(calls.length === 1, spec.file + ' P4 register_partner called exactly once -- got ' + calls.length);
  ok(a.p_utm_source === 'facebook' && a.p_utm_medium === 'paid' && a.p_utm_campaign === spec.funnel && a.p_fbclid === 'REALISH' && a.p_funnel_id === spec.funnel && a.p_agent_type === spec.agentType,
    spec.file + ' P4 register_partner receives p_utm_*/p_fbclid/p_funnel_id/p_agent_type from the URL -- got ' + JSON.stringify(a));
  await ctx.close();
}

// ── negative controls, applied at serve time to ONE page (re-1) and mirrored on the others ──
function mustReplace(text, re, to, what) {
  if (!re.test(text)) throw new Error('mutation target not found: ' + what);
  return text.replace(re, to);
}
async function expectRed(name, spec, mutate, labelRe) {
  let res;
  try {
    // Apply each mutation to the on-disk file first: a missing target throws HERE (a FAIL), never mid-request.
    for (const [p, fn] of Object.entries(mutate)) fn(fs.readFileSync(path.join(repoRoot, p.replace(/^\//, '')), 'utf8'));
    res = await pageChecks(spec, mutate);
  } catch (e) { ok(false, name + ' ' + spec.file + ' -- mutation could not be applied: ' + e.message); return; }
  const hit = Object.entries(res).filter(([l]) => labelRe.test(l));
  ok(hit.length > 0 && hit.every(([, v]) => v === false), name + ' ' + spec.file + ' -- mutated page makes the check go RED as required [' + hit.map(([l, v]) => (v ? 'green' : 'RED') + ': ' + l).join(' | ') + ']');
}
for (const spec of PAGES) {
  const url = '/' + spec.file;
  // PN1: header loses data-skip-nav -> nav.js builds the header -> "no nav render" goes red.
  await expectRed('PN1', spec, { [url]: (t) => mustReplace(t, /(<header id="site-header"[^>]*?)\s*data-skip-nav="true"/, '$1', 'header data-skip-nav') }, /no nav header/);
  // PN2: one character of the D-266 disclaimer / no-fee statement changes -> P3 goes red.
  if (spec.legal === 'fee+d266') {
    await expectRed('PN2', spec, { [url]: (t) => mustReplace(t, /lawful for you to accept referral fees\./, 'lawful for you to accept referral fee.', 'D-266 text') }, /D-266 disclaimer byte-identical/);
  } else {
    await expectRed('PN2', spec, { [url]: (t) => mustReplace(t, /do not receive a referral fee or recruit bonus\./, 'do not receive a referral fee or recruit bonuses.', 'no-fee statement') }, /no-fee statement byte-identical/);
  }
  // PN3: wrap the logo in an <a> -> P1 non-link goes red.
  await expectRed('PN3', spec, { [url]: (t) => mustReplace(t, /(<img[^>]*otter-quotes-icon-512\.png[^>]*>)/, '<a href="/">$1</a>', 'logo img') }, /non-link/);
}

// PN4: the snippet is self-contained per page -- it must not exist in shared JS/CSS, and the
// other surfaces must render without it.
async function sharedSurfaceCheck() {
  const bad = [];
  for (const f of ['js/nav.js', 'css/nav.css', 'css/design-system.css']) {
    const txt = mutations.has('/' + f) ? mutations.get('/' + f)(fs.readFileSync(path.join(repoRoot, f), 'utf8')) : fs.readFileSync(path.join(repoRoot, f), 'utf8');
    if (/oq-trust|oqTrustPhoto/.test(txt)) bad.push(f);
  }
  const ctx = await newContext();
  for (const u of ['/start.html?v=f', '/start.html', '/partner-re.html', '/partner-insurance.html']) {
    const page = await loadPage(ctx, u);
    const n = await page.evaluate(() => document.querySelectorAll('.oq-trust,#oqTrustPhoto,[data-oq-trust-header]').length);
    if (n) bad.push(u + ' renders ' + n + ' trust element(s)');
    await page.close();
  }
  await ctx.close();
  return bad;
}
mutations.clear();
{
  const bad = await sharedSurfaceCheck();
  ok(bad.length === 0, 'PN4 /start (?v=f and bare), partner-re.html, partner-insurance.html and shared js/nav.js + css/nav.css + css/design-system.css carry no trust snippet -- offenders: ' + JSON.stringify(bad));
  mutations.set('/css/nav.css', (t) => t + '\n.oq-trust{display:flex}\n');
  const bad2 = await sharedSurfaceCheck();
  ok(bad2.length > 0, 'PN4 control: the snippet injected into shared css/nav.css makes the check go RED as required -- offenders: ' + JSON.stringify(bad2));
  mutations.clear();
}

await browser.close();
server.close();
console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
