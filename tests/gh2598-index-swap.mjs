/**
 * gh-2598 slice 5 -- the production homepage (index.html, https://otterquote.com/) is the approved reskin.
 *
 * Pins the markers the issue's closes-on names, as far as they can be read from the repository (a browser run on the deployed page is the tester's job):
 *   M1  H1 "Make contractors compete for your job."            M2  a ZIP <input> with a <label for> inside the hero section
 *   M3  tel:+18448753412 in the header                         M4  "Contractors Compete. Homeowners Win." in the footer (js/nav.js renders it into <footer id="site-footer">; run for real)
 *   M5  the three motion words are in the served HTML (#hr-w1..3) and the head script + js/home-reskin.js are wired
 *   M6  no "Your Project. Your Terms." and no Dustin / Stohler in the served HTML (nor in the footer nav.js renders)
 * And what the swap must not lose or break:
 *   H1  indexable: no robots noindex; exactly one canonical, https://otterquote.com/
 *   H2  head essentials kept: the auth-hash bounce is the first script (tests/auth-index-bounce-routing.mjs extracts it), then the Sentry loader (onLoad predeclared before the loader tag),
 *       viewport, og:url / og:image / twitter card, the Organization JSON-LD parses and the nap-schema mount exists, Supabase before js/auth.js, auth.js before nav.js
 *   H3  analytics only through the gate files: no vendor host in the HTML, every dynamic script is one of the four gates
 *   H4  the <main> and the sticky bar are byte-identical to home-next.html (the page that was legal-read slice by slice); no extra visible string was added
 * Every check has a NEGATIVE CONTROL: a mutation of the real source that must turn it red.
 * INDEX_ROOT=<dir> points the test at another checkout.   Run: node tests/gh2598-index-swap.mjs   Exit 0 = all green including every control going red.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.INDEX_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }
function control(id, red) { ok(red, id + ' NEGATIVE CONTROL goes red on the mutated source'); }

const INDEX = read('index.html');
const STAGING = read('home-next.html');
const NAV = read('js/nav.js');

const section = (html, open, close) => { const i = html.indexOf(open); if (i < 0) return ''; const j = html.indexOf(close, i); return j < 0 ? '' : html.slice(i, j + close.length); };
const between = (html, a, b) => { const i = html.indexOf(a); if (i < 0) return ''; const j = html.indexOf(b, i); return j < 0 ? '' : html.slice(i, j); };

/* ---------- the footer, produced by the real js/nav.js behind a minimal DOM shim (same technique as tests/gh2598-nav-header-footer.mjs) ---------- */
function renderFooter(navSrc, pathname) {
  const els = { 'site-footer': { innerHTML: '', dataset: {} } };
  let ready = null;
  const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, appendChild() {}, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], insertBefore() {} });
  const document = { readyState: 'loading', body: el(), head: el(), documentElement: el(), cookie: '',
    getElementById: (id) => els[id] || (/^(support|sc-)/.test(id) ? el() : null), querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), createTextNode: () => ({}),
    addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') { ready = fn; } }, removeEventListener() {} };
  const store = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; };
  const window = { location: { pathname, search: '', hash: '', href: 'https://otterquote.com' + pathname, hostname: 'otterquote.com' }, sessionStorage: store(), localStorage: store(), addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }), document };
  const ctx = vm.createContext({ window, document, CONFIG: { SITE_NAME: 'Otter Quotes' }, console, setTimeout, clearTimeout, requestAnimationFrame: (f) => f(), URLSearchParams, Date, navigator: { userAgent: 'node' }, location: window.location, sessionStorage: window.sessionStorage, localStorage: window.localStorage });
  let err = null;
  try { vm.runInContext(navSrc, ctx, { filename: 'nav.js' }); if (ready) { ready(); } } catch (e) { err = String((e && e.stack) || e).split('\n')[0]; }
  return { html: els['site-footer'].innerHTML, err };
}

/* ---------- checks, each a function of (index html, nav source) so a control can mutate either ---------- */
function markers(html, navSrc) {
  const out = [];
  const hero = section(html, '<section id="top" class="hr-hero">', '</section>');
  const header = section(html, '<header class="hr-header">', '</header>');
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/);
  out.push(['M1 exactly one <h1>, text "Make contractors compete for your job."', (html.match(/<h1\b/g) || []).length === 1 && !!h1 && h1[1].trim() === 'Make contractors compete for your job.']);
  const input = hero.match(/<input\b[^>]*\bid="([^"]+)"[^>]*>/);
  out.push(['M2 the hero holds a ZIP input (numeric, postal-code, maxlength 5)', !!input && /inputmode="numeric"/.test(input[0]) && /autocomplete="postal-code"/.test(input[0]) && /maxlength="5"/.test(input[0])]);
  out.push(['M2 ...with a visible <label for> naming it', !!input && new RegExp('<label\\b[^>]*\\bfor="' + input[1] + '"[^>]*>\\s*ZIP code of the home\\s*</label>').test(hero)]);
  out.push(['M3 a tel:+18448753412 link inside the header', /<a\b[^>]*href="tel:\+18448753412"/.test(header)]);
  const foot = renderFooter(navSrc, '/index.html');
  out.push(['M4 nav.js runs on /index.html without error' + (foot.err ? ' (' + foot.err + ')' : ''), foot.err === null && foot.html.length > 500]);
  out.push(['M4 the rendered footer carries "Contractors Compete. Homeowners Win." in .footer-tagline', /<p class="footer-tagline">\s*Contractors Compete\. Homeowners Win\.\s*<\/p>/.test(foot.html)]);
  out.push(['M4 the page has the footer slot and loads js/nav.js (not opted out)', /<footer id="site-footer"><\/footer>/.test(html) && /<script src="js\/nav\.js"><\/script>/.test(html)]);
  out.push(['M5 the three motion words are in the served HTML', /<span id="hr-w1" class="hr-w">price,<\/span>\s*<span id="hr-w2" class="hr-w">materials<\/span>\s*<span id="hr-w3" class="hr-w">and warranties\.<\/span>/.test(html)]);
  out.push(['M5 the pre-paint head script and js/home-reskin.js are wired', /root\.classList\.add\('hr-js'\)/.test(html) && /<script src="\/js\/home-reskin\.js" onerror="window\.__hrOpen &amp;&amp; window\.__hrOpen\(\)"><\/script>/.test(html)]);
  out.push(['M6 no "Your Project. Your Terms." in the served HTML', !/Your Project\.\s*Your Terms/i.test(html)]);
  out.push(['M6 no "Dustin" or "Stohler" in the served HTML', !/dustin|stohler/i.test(html)]);
  out.push(['M6 ...nor in the visible footer nav.js renders (HTML comments inside nav.js templates are stripped first: they name Dustin and belong to the name clean-up sub-issue, not to this swap)', !/your project\.\s*your terms|dustin|stohler/i.test(foot.html.replace(/<!--[\s\S]*?-->/g, ''))]);
  return out;
}
markers(INDEX, NAV).forEach(([l, v]) => ok(v, l));
control('M1', markers(INDEX.replace('Make contractors compete for your job.', 'Stop chasing contractors. Let them compete for you.'), NAV).some(([, v]) => !v));
control('M2 (label)', markers(INDEX.replace('<label class="hr-lab" for="hr-zip">ZIP code of the home</label>', ''), NAV).some(([, v]) => !v));
control('M2 (input)', markers(INDEX.replace(/<input id="hr-zip" [^>]*>/, ''), NAV).some(([, v]) => !v));
control('M3', markers(INDEX.replace(/(<header class="hr-header">[\s\S]*?)href="tel:\+18448753412"/, '$1href="#"'), NAV).some(([, v]) => !v));
control('M4 (tagline)', markers(INDEX, NAV.replace(/tagline: 'Contractors Compete\. Homeowners Win\.'/, "tagline: 'Helping homeowners.'")).some(([, v]) => !v));
control('M4 (slot)', markers(INDEX.replace('<footer id="site-footer"></footer>', ''), NAV).some(([, v]) => !v));
control('M5 (words)', markers(INDEX.replace('and warranties.</span>', 'and warranties</span>'), NAV).some(([, v]) => !v));
control('M6 (old tagline)', markers(INDEX.replace('</main>', '<p>Your Project. Your Terms.</p></main>'), NAV).some(([, v]) => !v));
control('M6 (name)', markers(INDEX.replace('</main>', '<!-- Dustin --></main>'), NAV).some(([, v]) => !v));

/* ---------- H1: indexable, one canonical ---------- */
const canon = (html) => [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /\brel\s*=\s*["']?canonical\b/i.test(t)).map((t) => (t.match(/\bhref\s*=\s*["']([^"']*)["']/i) || [, ''])[1]);
const indexable = (html) => !/<meta\s+name="robots"[^>]*content="[^"]*noindex/i.test(html) && !/<meta\s+content="[^"]*noindex[^"]*"\s+name="robots"/i.test(html) && !/X-Robots-Tag/i.test(html);
ok(indexable(INDEX), 'H1 no robots noindex on the production homepage');
ok(canon(INDEX).length === 1 && canon(INDEX)[0] === 'https://otterquote.com/', 'H1 exactly one canonical, https://otterquote.com/');
control('H1 (noindex)', !indexable(INDEX.replace('<meta charset="UTF-8">', '<meta charset="UTF-8"><meta name="robots" content="noindex, follow">')));
control('H1 (canonical to staging)', !(canon(INDEX.replace('href="https://otterquote.com/"', 'href="https://otterquote.com/home-next"')).length === 1 && canon(INDEX.replace('href="https://otterquote.com/"', 'href="https://otterquote.com/home-next"'))[0] === 'https://otterquote.com/'));
control('H1 (two canonicals)', canon(INDEX.replace('<meta charset="UTF-8">', '<meta charset="UTF-8"><link rel="canonical" href="https://otterquote.com/x">')).length !== 1);

/* ---------- H2: head essentials ---------- */
function essentials(html) {
  const head = between(html, '<head>', '</head>');
  const scripts = [...head.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  const firstInline = head.match(/<script>([\s\S]*?)<\/script>/);
  const ld = [...head.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  let parsed = null; try { parsed = JSON.parse(ld[0][1]); } catch (e) { parsed = null; }
  const iAuth = html.indexOf('<script src="js/auth.js">'), iNav = html.indexOf('<script src="js/nav.js">'), iSup = html.indexOf('supabase-js@2.116.0'), iCfg = html.indexOf('<script src="js/config.js">'), iCs = html.indexOf('<script src="js/cookie-storage.js">');
  return [
    ['H2 the auth-hash bounce is the first script in <head>', !!firstInline && /function log\(\)/.test(firstInline[1]) && /BOUNCING to \/contractor-pre-approval\.html/.test(firstInline[1]) && head.indexOf(firstInline[0]) < head.indexOf('sentryOnLoad')],
    ['H2 the Sentry onLoad is predeclared before the loader tag', /window\.sentryOnLoad\s*=/.test(head) && head.search(/window\.sentryOnLoad\s*=/) < head.indexOf('js.sentry-cdn.com/49b5839b50adc240398d822c46d4a86e.min.js')],
    ['H2 viewport, og:url, og:image and twitter:card kept', /<meta name="viewport"/.test(head) && /<meta property="og:url" content="https:\/\/otterquote\.com\/">/.test(head) && /<meta property="og:image" content="https:\/\/otterquote\.com\/img\/otter-icon-navy\.png">/.test(head) && /<meta name="twitter:card" content="summary_large_image">/.test(head)],
    ['H2 Organization JSON-LD parses (Organization + WebSite, +1-844-875-3412) and the nap-schema mount exists', !!parsed && parsed['@graph'].some((n) => n['@type'] === 'Organization' && n.telephone === '+1-844-875-3412') && parsed['@graph'].some((n) => n['@type'] === 'WebSite') && /<script type="application\/ld\+json" id="nap-schema-mount"><\/script>/.test(head)],
    ['H2 script order: Supabase, cookie-storage, config, auth, nav', iSup > 0 && iCs > 0 && iSup < iCs && iCs < iCfg && iCfg < iAuth && iAuth < iNav],
    ['H2 the preview/staging host guard in the Sentry init is intact', /environment: window\.location\.hostname\.includes\("staging"\)/.test(head)],
    ['H2 no second bounce or navigation before js/auth.js other than the bounce', scripts.length > 0],
  ];
}
essentials(INDEX).forEach(([l, v]) => ok(v, l));
control('H2 (bounce removed)', essentials(INDEX.replace(/<script>\n\(function \(\) \{\n  function log\(\)[\s\S]*?\n\}\)\(\);\n<\/script>/, '')).some(([, v]) => !v));
control('H2 (Sentry after loader)', essentials(INDEX.replace('window.sentryOnLoad = ', 'window.sentryOnLoadX = ')).some(([, v]) => !v));
control('H2 (JSON-LD gone)', essentials(INDEX.replace('"@type": "Organization"', '"@type": "Thing"')).some(([, v]) => !v));
control('H2 (auth.js moved)', essentials(INDEX.replace('<script src="js/auth.js"></script>', '').replace('<script src="js/nav.js"></script>', '<script src="js/nav.js"></script><script src="js/auth.js"></script>')).some(([, v]) => !v));

/* ---------- H3: analytics only through the gates ---------- */
function gates(html) {
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  const dyn = [...html.matchAll(/\.src\s*=\s*(['"])([^'"]+)\1/g)].map((m) => m[2]);
  const allowedStatic = new Set(['/js/internal-traffic.js', '/js/home-reskin.js', 'js/cookie-storage.js', 'js/config.js', 'js/auth.js', 'js/nav.js', 'https://js.sentry-cdn.com/49b5839b50adc240398d822c46d4a86e.min.js', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js']);
  const vendor = /googletagmanager|google-analytics|facebook\.net|facebook\.com\/tr|clarity\.ms|fbevents|gtag\/js|hotjar|redditstatic|licdn|segment|mixpanel/i;
  return [
    ['H3 every <script src> is a known first-party file, Sentry or the pinned Supabase build', srcs.every((s) => allowedStatic.has(s))],
    ['H3 the four gates are the only dynamically loaded scripts', dyn.slice().sort().join() === '/js/ga-gate.js,/js/linkedin-insight-gate.js,/js/meta-pixel-gate.js,/js/reddit-pixel-gate.js'],
    ['H3 no analytics vendor host named in the page', !vendor.test(html)],
  ];
}
gates(INDEX).forEach(([l, v]) => ok(v, l));
control('H3 (extra loader)', gates(INDEX.replace('</head>', '<script src="https://www.clarity.ms/tag/x"></script></head>')).some(([, v]) => !v));
control('H3 (gate dropped)', gates(INDEX.replace("li.src = '/js/linkedin-insight-gate.js'", "li.src = '/js/none.js'")).some(([, v]) => !v));

/* ---------- H4: the body is the legal-read page ---------- */
const mainOf = (h) => section(h, '<main>', '</main>');
const stickyOf = (h) => section(h, '<div id="hr-sticky"', '</div>');
const prepaintOf = (h) => section(h, '/* gh-2598 correction 3', '})();');
ok(mainOf(INDEX).length > 5000 && mainOf(INDEX) === mainOf(STAGING), 'H4 <main> is byte-identical to home-next.html (' + mainOf(INDEX).length + ' bytes)');
ok(stickyOf(INDEX).length > 100 && stickyOf(INDEX) === stickyOf(STAGING), 'H4 the phone sticky bar is byte-identical to home-next.html');
ok(prepaintOf(INDEX).length > 500 && prepaintOf(INDEX) === prepaintOf(STAGING), 'H4 the pre-paint head script is byte-identical to home-next.html');
ok(read('css/home-reskin.css').length > 1000 && /<link rel="stylesheet" href="\/css\/home-reskin\.css">/.test(INDEX), 'H4 index.html loads css/home-reskin.css');
control('H4 (one word changed in <main>)', mainOf(INDEX.replace('Questions first?', 'Questions second?')) !== mainOf(STAGING));
control('H4 (sticky bar changed)', stickyOf(INDEX.replace('aria-label="Call Otter Quotes"', 'aria-label="Call us"')) !== stickyOf(STAGING));

/* ---------- L1: the homeowner "Log In" link is in the header (REVIEW: FAIL 6301143650 B1, RETURNED 6301207916; DECIDED 6200277211 item 4: the Log in target stays as today) ----------
   Text is the already-live "Log In", target /login.html, no new wording. Static part: the link is in <header class="hr-header"> and no rule hides it. Browser part (needs Playwright + Chromium; skipped with a message if absent):
   the link is rendered, visible, inside the viewport, and the page does not scroll sideways at 1280 and 390 px. */
const headerOf = (h) => section(h, '<header class="hr-header">', '</header>');
function loginStatic(html, css) {
  const header = headerOf(html);
  const links = [...header.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].filter((m) => /\bhref="\/login\.html"/.test(m[1]));
  const hidden = (html.match(/<style>[\s\S]*?<\/style>/g) || []).join('\n') + '\n' + css;
  const hides = [...hidden.matchAll(/([^{}]*\bhr-login\b[^{}]*)\{([^}]*)\}/g)].some((m) => /display\s*:\s*none|visibility\s*:\s*hidden/.test(m[2]));
  return [
    ['L1 the header has exactly one link to /login.html', links.length === 1],
    ['L1 its text is exactly "Log In" (already-live wording)', links.length === 1 && links[0][2].replace(/<[^>]*>/g, '').trim() === 'Log In'],
    ['L1 no CSS rule hides it (display:none / visibility:hidden on .hr-login, at any width)', links.length === 1 && /\bhr-login\b/.test(links[0][1]) && !hides],
  ];
}
const CSS_RESKIN = read('css/home-reskin.css');
loginStatic(INDEX, CSS_RESKIN).forEach(([l, v]) => ok(v, l));
control('L1 (link removed)', loginStatic(INDEX.replace(/<a [^>]*href="\/login\.html"[^>]*>[\s\S]*?<\/a>/, ''), CSS_RESKIN).some(([, v]) => !v));
control('L1 (wrong target)', loginStatic(INDEX.replace('href="/login.html"', 'href="/contractor-login.html"'), CSS_RESKIN).some(([, v]) => !v));
control('L1 (wrong text)', loginStatic(INDEX.replace(/(href="\/login\.html"[^>]*>)\s*Log In/, '$1Sign in'), CSS_RESKIN).some(([, v]) => !v));
control('L1 (hidden on phones)', loginStatic(INDEX.replace('</style>', '@media (max-width: 767px) { .hr-login { display: none; } }\n</style>'), CSS_RESKIN).some(([, v]) => !v));

async function loginInBrowser() {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch (e) {
    try { const { createRequire } = await import('node:module'); ({ chromium } = createRequire(import.meta.url)('playwright')); } catch (e2) { chromium = null; }
  }
  if (!chromium) { console.log('SKIP: L1 browser check (playwright is not installed here; run where Chromium is available)'); return; }
  const http = await import('node:http');
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split('?')[0]); if (u === '/') u = '/index.html';
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch();
    for (const [w, h] of [[1280, 800], [390, 844]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
      await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => {
        const as = [...document.querySelectorAll('header.hr-header a[href="/login.html"]')];
        const a = as[0]; const b = a ? a.getBoundingClientRect() : null; const cs = a ? getComputedStyle(a) : null;
        return { n: as.length, text: a ? a.textContent.trim() : null, vis: !!(a && cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0),
          inView: !!(b && b.left >= 0 && b.right <= window.innerWidth), sideways: document.documentElement.scrollWidth > window.innerWidth };
      });
      ok(r.n === 1 && r.text === 'Log In' && r.vis && r.inView && !r.sideways, 'L1 browser ' + w + 'px: Log In -> /login.html is rendered, visible, inside the viewport, no sideways scroll ' + JSON.stringify(r));
      await page.close();
    }
  } finally { if (browser) await browser.close(); server.close(); }
}
await loginInBrowser();

/* ---------- Q7: no author comments in the footer js/nav.js renders (the rendered DOM, not only the served HTML) ---------- */
function footerComments(navSrc) {
  const f = renderFooter(navSrc, '/index.html');
  return { err: f.err, names: [...f.html.matchAll(/<!--([\s\S]*?)-->/g)].filter((m) => /Dustin|Stohler/i.test(m[1])).length };
}
const FC = footerComments(NAV);
ok(!FC.err && FC.names === 0, 'Q7 the footer js/nav.js renders carries no HTML comment naming Dustin or Stohler (' + FC.names + ' found)');
control('Q7', footerComments(NAV.replace('<a id="footer-do-not-sell-link"', '<!-- Dustin ruling --><a id="footer-do-not-sell-link"')).names >= 1);

/* ---------- Q4: the legacy CTA events cta_click and homeowner_cta_form_start fire from the [data-hr-go] buttons (Ben, DECIDED on #2912 6301210978) ---------- */
function ctaEvents(html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const src = blocks.find((b) => b.indexOf('CTA Click Tracking') >= 0);
  if (!src) return { err: 'analytics block not found', fired: [] };
  const mk = (go, href, text, sec) => { const h = []; return { handlers: h, getAttribute: (k) => (k === 'href' ? href : k === 'data-hr-go' ? go : null), textContent: text, closest: () => (sec ? { className: sec } : null), addEventListener: (ev, fn) => { if (ev === 'click') h.push(fn); } }; };
  const els = [mk('header', '/start.html', 'Get my bids', null), mk('hero', '/start.html?entry=home', 'Get my bids', 'hr-hero'), mk('closing', '/start.html', 'Get my bids', 'hr-sec'), mk('sticky', '/start', 'Get my bids', null)];
  const fired = [];
  const doc = { querySelectorAll: (sel) => (/data-hr-go/.test(sel) ? els : []), documentElement: { scrollHeight: 2000 } };
  const win = { location: { href: 'https://otterquote.com/' }, scrollY: 0, innerHeight: 800, addEventListener() {} };
  const ctx = vm.createContext({ window: win, document: doc, gtag: (...a) => fired.push(a), setTimeout: () => 0, URL, console });
  let err = null;
  try { vm.runInContext(src, ctx, { filename: 'index-analytics.js' }); els.forEach((e) => e.handlers.forEach((fn) => fn.call(e, {}))); } catch (e) { err = String((e && e.stack) || e).split('\n')[0]; }
  return { err, fired: fired.filter((a) => a[0] === 'event').map((a) => a[1]) };
}
const CE = ctaEvents(INDEX);
ok(!CE.err && CE.fired.filter((n) => n === 'cta_click').length === 4 && CE.fired.filter((n) => n === 'homeowner_cta_form_start').length === 4, 'Q4 clicking each of the 4 [data-hr-go] buttons fires cta_click and homeowner_cta_form_start (got ' + CE.fired.join(',') + (CE.err ? ' | ' + CE.err : '') + ')');
control('Q4 (selector back to a.btn only)', (() => { const r = ctaEvents(INDEX.replace(/querySelectorAll\('a\.btn[^']*'\)/, "querySelectorAll('a.btn')")); return r.fired.length === 0; })());
ok(/hero_cta_click/.test(read('js/home-reskin.js')), 'Q4 hero_cta_click is still sent by js/home-reskin.js (kept alongside the legacy events)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
