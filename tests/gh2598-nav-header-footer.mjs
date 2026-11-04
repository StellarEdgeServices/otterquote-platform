/**
 * gh-2598 slice 4 -- shared header tel link and footer tagline in js/nav.js.
 *
 * Spec (Marketing/site-reskin-2026-10/README.md, "Behaviour" and "Tagline (D-377)"; decomposition 6051878928, slice 4):
 *   - a tel:+18448753412 link in the header of every page, number "(844) 875-3412", the phone design's "Call" label on phones
 *   - "Contractors Compete. Homeowners Win." exactly so, in the shared footer slot (non-contractor footers; the contractor-portal pitch line is unchanged, see the PR's open questions)
 * It runs the REAL js/nav.js in a vm context behind a minimal DOM shim (the repo's usual technique), fires its DOMContentLoaded handler for several page types
 * and reads what it writes into #site-header and #site-footer.
 *
 *   H1  every page type gets exactly one header tel link: href tel:+18448753412, text (844) 875-3412, a "Call" label, placed before the actions block
 *   H2  the number and href come from NAP (the single source), not a second hand-typed copy
 *   F1  non-contractor footers carry the tagline in .footer-tagline and not the old "Helping homeowners ..." sentence
 *   F2  the contractor-portal footer keeps its own line (unchanged)
 *   F3  the old tagline never appears in nav.js
 * Every check has a NEGATIVE CONTROL: a mutation of nav.js that must turn it red.
 * NAV_ROOT=<dir> points the test at another checkout.   Run: node tests/gh2598-nav-header-footer.mjs   Exit 0 = all green including every control going red.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NAV_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js/nav.js'), 'utf8');
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }
function control(id, red) { ok(red, id + ' NEGATIVE CONTROL goes red on the mutated source'); }

/* page types: homeowner, contractor portal, partner, inspector track, role-neutral legal page, admin */
const PAGES = ['/index.html', '/how-it-works.html', '/contractor-dashboard.html', '/partner-re.html', '/partner-inspectors.html', '/terms.html', '/admin-dashboard.html'];

function render(src, pathname) {
  const out = { header: null, footer: null, error: null };
  const els = { 'site-header': { innerHTML: '', dataset: { active: '' } }, 'site-footer': { innerHTML: '', dataset: {} } };
  let ready = null;
  const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, appendChild() {}, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], insertBefore() {}, remove() {} });
  const document = {
    readyState: 'loading', body: el(), head: el(), documentElement: el(), cookie: '',
    getElementById: (id) => els[id] || (/^(support|sc-)/.test(id) ? el() : null), querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), createTextNode: () => ({}),
    addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') ready = fn; }, removeEventListener() {},
  };
  const store = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; };
  const window = { location: { pathname, search: '', hash: '', href: 'https://otterquote.com' + pathname, hostname: 'otterquote.com' }, sessionStorage: store(), localStorage: store(), addEventListener() {}, matchMedia: () => ({ matches: false }), innerWidth: 1280 };
  const ctx = vm.createContext({ window, document, CONFIG: { SITE_NAME: 'Otter Quotes' }, console, setTimeout, clearTimeout, requestAnimationFrame: (f) => f(), URLSearchParams, Date, navigator: { userAgent: 'node' }, fetch: () => Promise.reject(new Error('no network')) });
  ctx.window.document = document;
  try {
    vm.runInContext(src, ctx, { filename: 'nav.js' });
    if (ready) ready();
  } catch (e) { out.error = String(e && e.stack || e).split("\n").slice(0,3).join(" @ "); }
  out.header = els['site-header'].innerHTML; out.footer = els['site-footer'].innerHTML;
  return out;
}

const TEL = /<a class="nav-phone" href="tel:\+18448753412"/g;
function failures(src) {
  const f = [];
  for (const p of PAGES) {
    const r = render(src, p);
    if (r.error) { f.push(p + ': nav.js threw ' + r.error); continue; }
    const tels = r.header.match(TEL) || [];
    if (tels.length !== 1) f.push(p + ': header has ' + tels.length + ' nav-phone tel links, want 1');
    if (!/<span class="nav-phone-num">\(844\) 875-3412<\/span>/.test(r.header)) f.push(p + ': header number text is not (844) 875-3412');
    if (!/<span class="nav-phone-call">Call<\/span>/.test(r.header)) f.push(p + ': header has no "Call" label');
    const i = r.header.indexOf('class="nav-phone"'), j = r.header.indexOf('id="nav-actions"');
    if (!(i > -1 && j > -1 && i < j)) f.push(p + ': the tel link is not placed before the actions block');
    const isContractorFooter = /Your sales team/.test(r.footer);
    const tag = (r.footer.match(/<p class="footer-tagline">([\s\S]*?)<\/p>/) || [])[1];
    if (p === '/contractor-dashboard.html') {
      if (!isContractorFooter) f.push(p + ': contractor footer lost its own line');
    } else {
      if (!tag || tag.trim() !== 'Contractors Compete. Homeowners Win.') f.push(p + ': footer tagline is ' + JSON.stringify(tag && tag.trim()));
      if (/Helping homeowners get the best deal/.test(r.footer)) f.push(p + ': old footer sentence still rendered');
    }
  }
  if (/Helping homeowners get the best deal|Your Project\. Your Terms/.test(src)) f.push('nav.js still contains an old tagline');
  if ((src.match(/tel:\+1844875[0-9]{4}/g) || []).length !== 1) f.push('nav.js types the phone href more than once (NAP is the single source)');
  return f;
}

const base = failures(SRC);
ok(base.length === 0, 'H1/F1/F2/F3 real nav.js renders the tel link and tagline on all ' + PAGES.length + ' page types' + (base.length ? ' | ' + base.join(' | ') : ''));
const sample = render(SRC, '/index.html');
ok(sample.header.length > 500 && sample.footer.length > 500, 'the harness really rendered header (' + sample.header.length + ' chars) and footer (' + sample.footer.length + ' chars); an empty render must not pass');
ok(sample.footer.includes('href="tel:+18448753412"') && sample.footer.includes('(844) 875-3412'), 'the footer NAP block still carries the same tel link (unchanged)');

const mut = (a, b) => { if (!SRC.includes(a)) throw new Error('mutation anchor missing: ' + a); return SRC.replace(a, b); };
control('H1 (tel href changed)', failures(mut("phoneTelHref: 'tel:+18448753412'", "phoneTelHref: 'tel:+18005550100'")).length > 0);
control('H1 (header link removed)', failures(mut('${this._phoneLinkHTML()}', '')).length > 0);
/* MOVE, not delete: the link must still be rendered once (so the count check passes) and only its position changes -- only the placement check can turn this red. */
const AFTER_ACTIONS = "\n          ${wantsSignOutSlot ? '<span id=\"nav-signout-slot\"></span>' : ''}\n        </div>\n        <button class=\"nav-hamburger\"";
const moved = mut('        ${this._phoneLinkHTML()}\n        <div class="nav-actions" id="nav-actions">', '        <div class="nav-actions" id="nav-actions">').replace(AFTER_ACTIONS, AFTER_ACTIONS.replace('</div>\n', '</div>\n        ${this._phoneLinkHTML()}\n'));
ok(moved.split('this._phoneLinkHTML()').length === SRC.split('this._phoneLinkHTML()').length && moved !== SRC, 'H1 move mutation really moves the call (same number of call sites as the source, text changed)');
control('H1 (link moved after the actions block)', (() => { const f = failures(moved); return f.some((m) => /not placed before the actions block/.test(m)) && !f.some((m) => /nav-phone tel links, want/.test(m)); })());
control('H1 ("Call" label removed)', failures(mut('<span class="nav-phone-call">Call</span>', '')).length > 0);
control('H2 (a second hand-typed tel href added)', failures(SRC + '\n// <a href="tel:+18448753412">\n').length > 0);
control('F1 (tagline in sentence case)', failures(mut("tagline: 'Contractors Compete. Homeowners Win.'", "tagline: 'Contractors compete. Homeowners win.'")).length > 0);
control('F1 (old footer sentence restored)', failures(mut(': NAP.tagline', ": 'Helping homeowners get the best deal on roofing and exterior projects.'")).length > 0);
control('F2 (contractor line replaced)', failures(mut("'Your sales team — without the truck, the manager, or the advance.'", 'NAP.tagline')).length > 0);

/* gh-3352: the footer Pricing link is homeowner-facing; every partner page (partners.html, partner-*.html, /partners/*) must not carry it, homeowner pages keep it, contractor footers never had it */
/* any <a> whose href points at the pricing page: /pricing.html, the pretty /pricing, an absolute URL on any host, any case, an optional trailing slash, query or fragment */
const PRICING = /<a\b[^>]*\bhref\s*=\s*["']?(?:https?:\/\/[^\/"'\s>]+)?\/pricing(?:\.html)?\/?(?:[?#][^"'\s>]*)?["'\s>]/i;
const PARTNER_PAGES = ['/partners', '/partners/', '/Partners.html', '/PARTNERS', '/partners.html', '/partner-re.html', '/partner-inspectors.html', '/partner-dashboard.html', '/partner-login.html', '/partner-agreement.html', '/partners/some-article.html'];
const HOMEOWNER_PAGES = ['/', '/pricing', '/index.html', '/how-it-works.html', '/pricing.html', '/faq.html', '/ref-demo.html', '/terms.html'];
const pricingFailures = (src) => {
  const f = [];
  for (const p of PARTNER_PAGES) { const r = render(src, p); if (r.error) f.push(p + ' threw'); else if (PRICING.test(r.footer)) f.push(p + ' footer has Pricing'); }
  for (const p of HOMEOWNER_PAGES) { const r = render(src, p); if (r.error) f.push(p + ' threw'); else if (!PRICING.test(r.footer)) f.push(p + ' footer lost Pricing'); }
  return f;
};
/* the selector itself: it must see every spelling of the link (a selector that misses one would pass a leak) and must not see look-alikes */
ok(['<a href="/pricing.html">', '<a href="/pricing">', '<a class="x" href="/Pricing.HTML">', '<a href="https://otterquote.com/pricing">', '<a href="http://www.otterquote.com/PRICING/">', '<a href=\'/pricing?x=1\'>', '<a href="/pricing#fees">', '<a href=/pricing >'].every((h) => PRICING.test(h))
  && ['<a href="/pricing-guide.html">', '<a href="/pricingx">', '<a href="/faq.html">Pricing', '<a href="/blog/pricing.html">', '<a href="https://otterquote.com/guides/pricing">'].every((h) => !PRICING.test(h)),
  'P1 the Pricing selector matches /pricing.html, /pricing, absolute URLs and case variants, and not look-alikes');
{ const f = pricingFailures(SRC); ok(f.length === 0, 'P1 Pricing is absent from ' + PARTNER_PAGES.length + ' partner footers and present on ' + HOMEOWNER_PAGES.length + ' homeowner footers' + (f.length ? ' | ' + f.join(' | ') : '')); }
control('P1 (partner gate removed: Pricing back on partner pages)', pricingFailures(mut("!this._isInspectorTrack() && !this._isPartnerPage() ? '<a href=\"/pricing.html\">Pricing", "!this._isInspectorTrack() ? '<a href=\"/pricing.html\">Pricing")).length > 0);
const OLD_IS_PARTNER = "const token = this._normalizePageToken(this._currentFile());";
{ const i = SRC.indexOf('_isPartnerPage() {'), j = SRC.indexOf('\n  },', i); const body = SRC.slice(i, j);
  const old = SRC.slice(0, i) + "_isPartnerPage() {\n    const file = this._currentFile();\n    return file === 'partners.html' || file.startsWith('partner-') || window.location.pathname.indexOf('/partners/') === 0;" + SRC.slice(j);
  ok(i > 0 && body.includes(OLD_IS_PARTNER), 'P1 setup: _isPartnerPage goes through _normalizePageToken');
  const f = pricingFailures(old);
  control('P1 (the previous _isPartnerPage: /partners, /Partners.html and /PARTNERS leak Pricing)', ['/partners ', '/Partners.html', '/PARTNERS '].every((p) => f.some((m) => m.startsWith(p)))); }
control('P1 (Pricing hidden everywhere: homeowner footers lose it)', pricingFailures(mut("!this._isInspectorTrack() && !this._isPartnerPage() ? '<a href=\"/pricing.html\">Pricing", "false ? '<a href=\"/pricing.html\">Pricing")).length > 0);
{ const r = render(SRC, '/contractor-dashboard.html'); ok(!PRICING.test(r.footer), 'P1 the contractor-portal footer has no Pricing link (unchanged)'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
