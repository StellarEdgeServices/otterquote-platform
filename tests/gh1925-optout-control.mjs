/**
 * gh-1925 item 2 -- the in-page CPRA opt-out control (footer link + privacy section 12 button).
 * Dustin ruling 5881048326 approved EXACTLY two strings; no other new wording is allowed:
 *   footer link:    "Do Not Sell or Share My Personal Information"
 *   section 12 btn: "Opt out of sale/sharing"
 *
 * Asserts: (a) the exact strings; (b) the button writes the SAME oq_ad_optout cookie the GPC path writes (the real
 * inline script in privacy.html and the real js/meta-pixel-gate.js are both executed in vm and their cookie writes compared);
 * (c) every page that carries a footer either renders it through js/nav.js (whose template carries the link) or carries the
 * link itself, pointing at privacy.html#<the section 12 id>, with a named allowlist for footers that carry no legal links.
 *
 * Run: node tests/gh1925-optout-control.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH1925_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); // GH1925_ROOT: negative controls run this file against another tree
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

const LINK_TEXT = 'Do Not Sell or Share My Personal Information';
const BTN_TEXT = 'Opt out of sale/sharing';
const ANCHOR = 'do-not-sell-or-share';

const privacy = read('privacy.html');
const nav = read('js/nav.js');

// ---- (a) exact strings + anchor ----
const btnMatch = privacy.match(/<button[^>]*id="oq-ad-optout-btn"[^>]*>([^<]*)<\/button>/);
ok(!!btnMatch && btnMatch[1] === BTN_TEXT, 'privacy.html section 12 button text is exactly "' + BTN_TEXT + '"');
ok(new RegExp('<section id="' + ANCHOR + '">\\s*<h2>12\\. California Privacy Rights').test(privacy), 'section 12 carries id="' + ANCHOR + '"');
ok(new RegExp('<a id="footer-do-not-sell-link" href="/privacy\\.html#' + ANCHOR + '">' + LINK_TEXT + '</a>').test(nav), 'js/nav.js footer template carries the exact link text + anchor');
ok(nav.split(LINK_TEXT).length === 2, 'js/nav.js carries the link text exactly once');

// ---- (b) the button writes the same cookie GPC writes ----
function makeCtx({ host, gpc, cookie = '' }) {
  const cookieWrites = []; let jar = cookie; const listeners = {};
  const btn = { disabled: false, addEventListener(t, fn) { listeners[t] = fn; } };
  const doc = {
    get cookie() { return jar; },
    set cookie(v) { cookieWrites.push(v); jar = v.split(';')[0]; },
    getElementById: (id) => (id === 'oq-ad-optout-btn' ? btn : null),
    createElement: (tag) => ({ tag }), head: { appendChild() {} }, documentElement: {},
    addEventListener() {}, removeEventListener() {},
    getElementsByTagName: () => [{ parentNode: { insertBefore() {} } }],
  };
  const win = { location: { hostname: host, hash: '', search: '', pathname: '/privacy.html' }, addEventListener() {}, removeEventListener() {}, requestIdleCallback: (fn) => { fn(); return 1; }, cancelIdleCallback() {} };
  win.window = win;
  const ctx = { window: win, document: doc, navigator: gpc === undefined ? {} : { globalPrivacyControl: gpc }, URLSearchParams, decodeURIComponent, setTimeout, clearTimeout, MutationObserver: function () { return { observe() {} }; } };
  vm.createContext(ctx);
  return { ctx, btn, listeners, cookieWrites };
}
const scripts = [...privacy.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.includes('oq-ad-optout-btn'));
ok(scripts.length === 1, 'privacy.html has exactly one inline script wiring the section 12 button');
const btnScript = scripts[0] || '';
const gateSrc = read('js/meta-pixel-gate.js');
for (const host of ['otterquote.com', 'www.otterquote.com', 'localhost']) {
  const g = makeCtx({ host, gpc: true }); vm.runInContext(gateSrc, g.ctx);
  const gpcCookie = g.cookieWrites[0];
  const b = makeCtx({ host }); vm.runInContext(btnScript, b.ctx);
  ok(b.cookieWrites.length === 0 && b.btn.disabled === false, host + ': no cookie written and button enabled until clicked');
  if (b.listeners.click) b.listeners.click();
  ok(!!gpcCookie && b.cookieWrites[0] === gpcCookie, host + ': button cookie is byte-identical to the GPC-path cookie (' + JSON.stringify(gpcCookie) + ')');
  ok(b.btn.disabled === true, host + ': button is disabled after click (no new wording)');
}
{
  const b = makeCtx({ host: 'otterquote.com', cookie: 'oq_ad_optout=1' }); vm.runInContext(btnScript, b.ctx);
  ok(b.btn.disabled === true, 'already opted out (cookie present): button starts disabled');
}

// ---- (c) enumerate every page with a footer ----
const SKIP_DIRS = new Set(['node_modules', '.git', 'Archive', 'react-app', 'handoffs', 'otterquote-deploy', 'supabase']);
const NO_LEGAL_LINKS_FOOTER = new Set([
  // gh-1925 (Ben ruling 5896607701): empty. stellar-edge.html used to be here; it loads the ad gates, so it now carries the link.
]);
const EMPTY_SKIPNAV_FOOTER = /<footer id="site-footer" data-skip-nav="true"><\/footer>/; // hi-*, ins-*: footer intentionally empty
function walk(d, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), out); }
    else if (e.name.endsWith('.html')) out.push(path.join(d, e.name).replace(/\\/g, '/'));
  }
  return out;
}
const pages = walk('').filter((p) => /<footer[\s>]/.test(read(p)));
ok(pages.length >= 90, 'enumerated ' + pages.length + ' html pages carrying a <footer>');
const hrefRe = new RegExp('href="(?:https://otterquote\\.com/|/)?privacy\\.html#' + ANCHOR + '"[^>]*>' + LINK_TEXT + '</a>');
let shared = 0, own = 0, empty = 0, allow = 0;
for (const p of pages) {
  const s = read(p);
  const isShared = /<footer[^>]*id="site-footer"/.test(s) && /js\/nav\.js/.test(s);
  if (NO_LEGAL_LINKS_FOOTER.has(p)) { allow++; continue; }
  if (hrefRe.test(s)) { own++; ok(true, p + ': footer carries the link itself'); continue; }
  if (EMPTY_SKIPNAV_FOOTER.test(s)) { empty++; ok(false, p + ': empty data-skip-nav footer (gh-1925: must carry the link, not be empty)'); continue; }
  if (isShared) { shared++; continue; } // rendered by js/nav.js, whose template is asserted above
  ok(false, p + ': footer has neither the link, nor the shared nav.js mount, nor an allowlist entry');
}
ok(shared >= 70, shared + ' pages render their footer through js/nav.js (link asserted once, in the template)');
console.log('INFO: shared=' + shared + ' own-link=' + own + ' empty-skip-nav=' + empty + ' allowlisted=' + allow);
// generators must emit the same link so regenerated pages do not lose it
for (const g of ['generate_contractor_pages', 'generate_location_pages', 'generate_partner_pages']) {
  ok(read('tools/' + g + '.py').includes('href="/privacy.html#' + ANCHOR + '" style="color:var(--amber)">' + LINK_TEXT + '</a>'), 'tools/' + g + '.py footer template carries the link');
}
// must-fix 3: the own-footer pages are asserted IN the page, never via the nav.js fall-through (re-1/3/5 also mount #site-footer).
for (const p of ['contractors/index.html', 'landing.html', 're-1.html', 're-3.html', 're-5.html']) {
  const m = read(p).match(/<footer[\s\S]*?<\/footer>/);
  ok(!!m && hrefRe.test(m[0]), p + ': its OWN <footer> element contains the exact link text + anchor (not via nav.js)');
}
// must-fix 2: the generator INDEX templates (contractor + partner directory) emit the link, so regeneration keeps it.
for (const [g, marker] of [['generate_contractor_pages', 'index_path = CONTRACTOR_DIR'], ['generate_partner_pages', 'index_path = PARTNERS_DIR']]) {
  const src = read('tools/' + g + '.py'); const i = src.indexOf(marker);
  const tail = src.slice(Math.max(0, i - 700), i);
  ok(i > 0 && tail.includes('<footer') && tail.includes('href="/privacy.html#' + ANCHOR + '" style="color:var(--amber)">' + LINK_TEXT + '</a>'), 'tools/' + g + '.py INDEX template footer carries the link');
}
// must-fix 1: the button's cookie reaches the server. A cookie-only visitor (real button script, GPC absent/false) sends gpc:true.
{
  const svc = read('js/services.js');
  const PARAMS = { claim_id: 'c1', amount: 1500, description: 'Complete Property Report' };
  async function bodyFor({ nav, cookie }) {
    const invoked = [];
    const ctx = { sb: { functions: { invoke: (n, o) => { invoked.push(o.body); return Promise.resolve({ data: {}, error: null }); } } }, console, decodeURIComponent };
    if (nav !== undefined) ctx.navigator = nav;
    ctx.document = { get cookie() { return cookie; } };
    vm.createContext(ctx);
    vm.runInContext(svc + '\n;globalThis.__S = Services;', ctx);
    await ctx.__S.createHoverPaymentIntent(PARAMS);
    return invoked[0];
  }
  const b = makeCtx({ host: 'otterquote.com' }); vm.runInContext(btnScript, b.ctx); b.listeners.click();
  const jar = b.ctx.document.cookie; // the cookie exactly as the real button script left it
  ok(jar === 'oq_ad_optout=1', 'real button script leaves cookie jar "' + jar + '"');
  for (const nav of [{ globalPrivacyControl: false }, {}, undefined]) {
    const body = await bodyFor({ nav, cookie: jar });
    ok(body.gpc === true, 'static services.js: cookie-only visitor (navigator ' + JSON.stringify(nav) + ') -> create-payment-intent body carries gpc:true');
  }
  ok((await bodyFor({ nav: { globalPrivacyControl: false }, cookie: '' })).gpc === undefined, 'static services.js: no cookie and no GPC -> no gpc field');
  ok((await bodyFor({ nav: {}, cookie: 'a=1; oq_ad_optout=10' })).gpc === undefined, 'static services.js: oq_ad_optout=10 is not a match');
  ok((await bodyFor({ nav: {}, cookie: 'a=1; oq_ad_optout=1; b=2' })).gpc === true, 'static services.js: oq_ad_optout=1 among other cookies matches');
  // N1 (REVIEW 5896098325): a malformed cookie must never turn a GPC visitor into {}.
  ok((await bodyFor({ nav: { globalPrivacyControl: true }, cookie: 'oq_ad_optout=%' })).gpc === true, 'static services.js N1: oq_ad_optout=% + GPC true -> gpc:true');
  ok((await bodyFor({ nav: { globalPrivacyControl: false }, cookie: 'oq_ad_optout=%' })).gpc === undefined, 'static services.js N1: oq_ad_optout=% + GPC false -> no gpc field');
  ok((await bodyFor({ nav: { globalPrivacyControl: false }, cookie: 'oq_ad_optout=1' })).gpc === true, 'static services.js N1: oq_ad_optout=1 + GPC false -> gpc:true');
}
// ---- (d) gh-1925 / Ben ruling 5896607701: EVERY page that loads an ad tag carries the link ----
// "Ad tag" = the Meta / LinkedIn / Reddit gate scripts (js/meta-pixel-gate.js, js/linkedin-insight-gate.js, js/reddit-pixel-gate.js).
// The static gates are host-gated, not path-gated, so every static page that includes one loads the tag on a production host.
// GA4/Clarity (ga-gate.js alone) is analytics, not an ad tag, and is out of scope of the ruling.
// Any reference to a gate file counts (start.html loads them through a dynamic loader, not a <script src>).
const AD_GATE_RE = /js\/(meta-pixel-gate|linkedin-insight-gate|reddit-pixel-gate)\.js/;
const allHtml = walk('');
const adPages = allHtml.filter((p) => AD_GATE_RE.test(read(p)));
ok(adPages.length >= 70, 'generic scan found ' + adPages.length + ' static pages that load an ad-tag gate');
// A page needs the link in its OWN markup unless js/nav.js builds a visible footer for it. nav.js does NOT build one when the
// footer mount carries data-skip-nav (hi-*, ins-*), when a script sets data-skip-nav on it at load (start.html Arm F), when the
// page has no #site-footer mount at all, or when the footer is hand-written (no mount).
function navBuildsFooter(s) {
  if (!/js\/nav\.js/.test(s)) return false;
  if (!/<footer[^>]*id="site-footer"/.test(s)) return false;
  if (/<footer[^>]*id="site-footer"[^>]*data-skip-nav/.test(s)) return false;
  if (/getElementById\('site-footer'\)[\s\S]{0,200}setAttribute\('data-skip-nav'/.test(s)) return false;
  return true;
}
let adOwn = 0, adNav = 0; const adMissing = [];
for (const p of adPages) {
  const s = read(p);
  if (hrefRe.test(s)) { adOwn++; continue; }
  if (navBuildsFooter(s)) { adNav++; continue; }
  adMissing.push(p);
}
ok(adMissing.length === 0, 'GUARD: every ad-gate page carries the link (own markup, or a nav.js-built footer)' + (adMissing.length ? ' -- MISSING on: ' + adMissing.join(', ') : ''));
console.log('INFO: ad-gate pages=' + adPages.length + ' own-link=' + adOwn + ' via-nav.js=' + adNav + ' missing=' + adMissing.length);
// Pages the ruling names, asserted IN their own markup (never via the nav.js fall-through).
for (const p of ['hi-1.html', 'hi-4.html', 'hi-5.html', 'ins-1.html', 'ins-3.html', 'ins-5.html']) {
  const s = read(p);
  const m = s.match(/<footer id="site-footer" data-skip-nav="true">([\s\S]*?)<\/footer>/);
  ok(!!m && hrefRe.test(m[1]) && (m[1].match(/<a /g) || []).length === 1, p + ': its skip-nav <footer> holds the link and NOTHING else (exactly one anchor)');
  ok(!!m && !/href="\/(index|how-it-works|faq|get-started|blog)/.test(m[1]), p + ': footer stays skip-nav and re-adds no escape hatch');
}
{
  const s = read('start.html');
  const m = s.match(/<div id="oq-armf-dns"><a id="footer-do-not-sell-link-armf" href="\/privacy\.html#do-not-sell-or-share">Do Not Sell or Share My Personal Information<\/a><\/div>/);
  ok(!!m, 'start.html: Arm F link element carries the exact string + anchor');
  ok(/#oq-armf-dns \{ display: none; \}/.test(s) && /html\[data-oq-start-arm="f"\] #oq-armf-dns \{ display: block;/.test(s), 'start.html: the Arm F link is hidden by default and shown ONLY under html[data-oq-start-arm="f"] (no duplicate of nav.js\'s footer link on arms A-E)');
  ok(/html\[data-oq-start-arm="f"\] #site-header, html\[data-oq-start-arm="f"\] #site-footer \{ display: none; \}/.test(s), 'start.html: Arm F still hides the nav.js header + footer (no escape hatch re-enabled)');
  ok(s.split(LINK_TEXT).length === 2, 'start.html: the link text appears exactly once');
}
for (const p of ['stellar-edge.html', 'guides/how-to-choose-contractor.html']) {
  const m = read(p).match(/<footer[\s\S]*?<\/footer>/);
  ok(!!m && hrefRe.test(m[0]), p + ': its OWN <footer> element contains the exact link text + anchor');
}
for (const p of ['assets/partner-onepager-insurance.html', 'assets/partner-onepager-re.html']) {
  const s = read(p);
  ok(new RegExp('<div class="footer-line oq-dns-line"><a href="https://otterquote\.com/privacy\.html#' + ANCHOR + '"[^>]*>' + LINK_TEXT + '</a></div>').test(s) && /@media print \{ \.oq-dns-line \{ display: none; \} \}/.test(s), p + ': footer line carries the link (absolute href) and is hidden in print so the one-pager layout is unchanged');
}
// re-3 / re-5 (and re-1) already carry it in their own footers (asserted above); assert no duplicate was introduced.
for (const p of ['re-1.html', 're-3.html', 're-5.html', 'landing.html']) ok(read(p).split(LINK_TEXT).length === 2, p + ': link text appears exactly once (no duplicate)');
// React app: the shells' footers and the /get-started page (MetaPixelGate ALLOWED_PATHS) carry the exact string + absolute href.
const RHREF = 'https://otterquote.com/privacy.html#' + ANCHOR;
for (const [p, cls] of [['react-app/app/(homeowner)/_shell/HomeownerShell.tsx', 'oqh'], ['react-app/app/contractor/_shell/ContractorShell.tsx', 'oqc']]) {
  const s = read(p);
  const m = s.match(/<footer className="[a-z]+-footer">([\s\S]*?)<\/footer>/);
  ok(!!m && m[1].includes('<a className="' + cls + '-footer-dns" href="' + RHREF + '">' + LINK_TEXT + '</a>'), p + ': footer carries the exact string + absolute href');
  ok(s.split(LINK_TEXT).length === 2, p + ': link text appears exactly once');
}
{
  const s = read('react-app/app/get-started/page.tsx');
  ok(s.includes('<a id="footer-do-not-sell-link" href="' + RHREF + '">' + LINK_TEXT + '</a>') && s.split(LINK_TEXT).length === 2, 'react-app get-started/page.tsx (loads the ad tags): carries the exact string + absolute href, once');
  ok(/ALLOWED_PATHS = \["\/get-started"/.test(read('react-app/app/components/MetaPixelGate.tsx')), 'get-started is still a MetaPixelGate ALLOWED_PATH (so the assertion above stays load-bearing)');
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
