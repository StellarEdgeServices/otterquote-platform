/**
 * gh-2598 slice 4 -- RENDERED-WIDTH check for the shared header (REVIEW FAIL 6200529604 M1; REVIEW FAIL 6201398978 M1b).
 * The markup test gh2598-nav-header-footer.mjs cannot see crowding; this one runs the REAL pages in headless Chromium over a local static server, with the real Rubik webfont
 * loaded (fonts.googleapis.com / fonts.gstatic.com, plus cdn.jsdelivr.net for the Supabase library the pages need to boot, are the only third-party hosts allowed), and sweeps 769..1300 px in two states:
 *
 *   SIGNED OUT  the guest auth buttons rendered by Nav's own _guestAuthHTML (same markup the live auth slot gets), on index, how-it-works, login, partner-re, contractor-join,
 *               and contractor-login. (contractor-dashboard is a signed-in page: signed out they redirect or render a header that never wraps, so they are
 *               measured signed in only; the old signed-out contractor-dashboard row measured exactly such a header and reported widest 0.)
 *   SIGNED IN   js/auth.js is served with a one-line stub appended (getUser / getSession / getRole / requireAuth / getProfile) so the site's own nav code renders the signed-in
 *               header (_renderAuthSlot / _updateNavLinksForRole). No markup is injected. Pages: contractor-dashboard, contractor-opportunities, contractor-profile (contractor),
 *               dashboard, index (homeowner). (admin-contractors left this sweep in gh-1772: it now carries the admin shell, not the shared header.) A signed-in header is wider than a signed-out one (Log Out / Sign Out plus the role links).
 *
 *   W1  no header text wraps at a width above the page's budget. Budgets are what main (a127acf4) wraps up to on the same page and state, measured with real Rubik:
 *       signed out 889 everywhere (production's widest, index/how-it-works/login); signed in contractor-dashboard 979, contractor-opportunities 999, contractor-profile 999,
 *       dashboard 959, index 959. A signed-in page that wraps wider than main's budget FAILS.
 *   W2  at 900, 1024, 1059, 1100, 1159, 1199, 1200 and 1280 (those above the page's budget) no header control (link or button) hangs below the 64 px bar and the header is no taller than at 1280
 *   W3  the tel link: full number from 1200 px up, icon alone (aria-label carries the number) at 769-1199, "Call" at <= 768; always one tel:+18448753412 link
 *   W4  the Rubik font really loaded (a fallback-font measurement is meaningless); ALLOW_NO_FONTS=1 downgrades this to a warning for offline runs
 *   W5  every signed-in page really rendered the signed-in header (a Log Out / Sign Out control in the header's .nav-actions, which is #nav-auth-slot on the pages with auth buttons and #nav-signout-slot on the contractor portal) and was not redirected away
 *   Negative controls: (a) nav.css with the compact-band rule removed must FAIL W1, W2 and W3; (b) the band narrowed back to max-width 1099 (the pre-M1b CSS) must FAIL W1 on a
 *   SIGNED-IN page.
 *
 * Run: node tests/gh2598-nav-header-width.mjs [repoRoot]    Needs Playwright + Chromium (tests/e2e lockfile in CI; PLAYWRIGHT_PATH or the global install locally).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(here, '..'));
let chromium;
try { ({ chromium } = createRequire(path.join(here, 'e2e', 'package.json'))('playwright')); }
catch {
  try { ({ chromium } = createRequire(import.meta.url)('playwright')); }
  catch { ({ chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright')); }
}
let pass = 0, fail = 0;
const ok = (c, l) => { console.log((c ? 'PASS: ' : 'FAIL: ') + l); c ? pass++ : fail++; };

/* gh-2598 slice 5: index.html is now the approved homepage, which has its own header (no #site-header, no shared nav) and is covered by tests/gh2598-index-swap.mjs; it is no longer a sample of the shared header here (how-it-works and dashboard stand in, same budgets). */
const OUT_BUDGET = 889;                   // signed out: production's widest wrap band (index, how-it-works, login)
const FULL_FROM = 1200;                   // the full number returns at this width
const STATES = [
  { name: 'signed-out', pages: ['how-it-works', 'login', 'partner-re', 'contractor-join', 'contractor-login'].map((pg) => ({ pg, role: null, budget: OUT_BUDGET })) },
  { name: 'signed-in', pages: [
    { pg: 'contractor-dashboard', role: 'contractor', budget: 979 },
    { pg: 'contractor-opportunities', role: 'contractor', budget: 999 },
    { pg: 'contractor-profile', role: 'contractor', budget: 999 },
    { pg: 'dashboard', role: 'homeowner', budget: 959 },
  ] },
];
const SWEEP = []; for (let w = 769; w <= 1300; w += 10) SWEEP.push(w);
const KEY = [820, 900, 1024, 1059, 1100, 1159, 1199, 1200, 1280]; for (const w of KEY) if (!SWEEP.includes(w)) SWEEP.push(w);
SWEEP.push(889, 890, 1099); SWEEP.sort((a, b) => a - b);
const NAV_CSS = fs.readFileSync(path.join(ROOT, 'css/nav.css'), 'utf8');
const BAND = /\/\* gh-2598-nav-compact-band[\s\S]*?\/\* \/gh-2598-nav-compact-band \*\/\n/;
if (!BAND.test(NAV_CSS)) { console.log('FAIL: css/nav.css has no gh-2598-nav-compact-band block'); process.exit(1); }

function serve(navCss) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      if (p === '/css/nav.css') { res.setHeader('content-type', 'text/css'); return res.end(navCss); }
      let f = path.join(ROOT, p);
      if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('nf'); }
      const ext = path.extname(f);
      res.setHeader('content-type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' })[ext] || 'application/octet-stream');
      res.end(fs.readFileSync(f));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function probe() {
  const h = document.querySelector('#site-header');
  if (!h) return { none: true };
  const wrapped = [];
  const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode; if (!n.textContent.trim()) continue;
    const el = n.parentElement, cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const hid = el.closest('.nav-hamburger,.nav-mobile-auth');
    if (hid && getComputedStyle(hid).display === 'none') continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const rg = document.createRange(); rg.selectNodeContents(n);
    const tops = new Set([...rg.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top)));
    if (tops.size > 1) wrapped.push(n.textContent.trim().slice(0, 20));
  }
  const bar = h.querySelector('.nav-inner'), bb = bar ? bar.getBoundingClientRect().bottom : 0;
  const hung = bar ? [...bar.querySelectorAll('a,button')].filter((e) => { const c = getComputedStyle(e); const q = e.getBoundingClientRect(); return c.display !== 'none' && q.width > 0 && q.bottom > bb + 1; }).map((e) => e.textContent.trim().slice(0, 14) || e.className) : [];
  const tels = [...h.querySelectorAll('a[href="tel:+18448753412"]')];
  const a = h.querySelector('a.nav-phone');
  const vis = (e) => !!e && getComputedStyle(e).display !== 'none';
  return { hh: Math.round(h.getBoundingClientRect().height), wrapped, hung, tels: tels.length, label: a ? a.getAttribute('aria-label') : null,
    num: vis(a && a.querySelector('.nav-phone-num')), call: vis(a && a.querySelector('.nav-phone-call')), iconW: a ? Math.round(a.getBoundingClientRect().width) : 0 };
}

const AUTH_JS = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
function stub(role) {
  return AUTH_JS + `\n;(function(){const U={id:'00000000-0000-0000-0000-000000000001',email:'probe@example.com'};Auth.getUser=async()=>U;Auth.getSession=async()=>({user:U});Auth.getRole=async()=>'${role}';Auth.requireAuth=async()=>U;Auth.getProfile=async()=>({role:'${role}'});Auth._getIsAdmin=async()=>${role === 'admin'};})();\n`;
}

async function sweep(browser, navCss, only) {   // only: optional list of 'state page' ids (the negative controls sweep a subset to keep CI time down)
  const server = await serve(navCss); const base = 'http://127.0.0.1:' + server.address().port;
  const bad = [], info = { fonts: true, widest: {}, hh: {}, rendered: 0, expected: 0 };
  for (const st of STATES) {
    for (const { pg, role, budget } of st.pages) {
      const id = st.name + ' ' + pg;
      if (only && !only.includes(id)) continue;
      info.expected++;
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await page.route('**/*', (r) => {
        const u = new URL(r.request().url());
        if (role && u.hostname === '127.0.0.1' && u.pathname === '/js/auth.js') return r.fulfill({ status: 200, contentType: 'text/javascript', body: stub(role) });
        return (u.hostname === '127.0.0.1' || /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net)$/.test(u.hostname)) ? r.continue() : r.abort();
      });
      await page.goto(base + '/' + pg + '.html', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
      await page.waitForSelector('#site-header .nav-phone', { timeout: 15000 }).catch(() => {});
      if (role) {
        // The signed-in header comes from the site's own nav code once the (stubbed) Auth resolves.
        await page.waitForFunction(() => /(log|sign) out/i.test((document.querySelector('#site-header .nav-actions') || {}).innerText || ''), null, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const slot = await page.evaluate(() => (document.querySelector('#site-header .nav-actions') || {}).innerText || '').catch(() => '');
        const landed = new URL(page.url()).pathname;
        if (!/(log|sign) out/i.test(slot) || !landed.includes(pg)) { bad.push('W5 ' + id + ': signed-in header did not render (actions "' + slot.replace(/\s+/g, ' ').trim().slice(0, 40) + '", landed on ' + landed + ')'); await ctx.close(); continue; }
      } else {
        // The signed-out auth buttons, from Nav's own markup (the live slot is filled by Auth and needs the network).
        await page.evaluate(() => {
          const slot = document.getElementById('nav-auth-slot');
          if (slot && !slot.children.length) slot.innerHTML = Nav._guestAuthHTML(Nav._activeRole || Nav._resolveRole()).desktop;
        }).catch(() => {});
      }
      await page.evaluate(() => document.fonts.load('500 16px Rubik').then(() => document.fonts.ready)).catch(() => {});
      const font = await page.evaluate(() => [...document.fonts].some((f) => f.family.includes('Rubik') && f.status === 'loaded')).catch(() => false);
      if (!font) info.fonts = false;
      const r = {};
      for (const w of [390, 768, 769, ...SWEEP]) {
        await page.setViewportSize({ width: w, height: 800 });
        await page.waitForTimeout(50);
        r[w] = await page.evaluate(probe);
      }
      if (r[1280].none) { bad.push(id + ': no #site-header rendered'); await ctx.close(); continue; }
      info.rendered++;
      const widest = Math.max(0, ...SWEEP.filter((w) => r[w].wrapped.length || r[w].hung.length).map((w) => w));
      info.widest[id] = widest;
      if (widest > budget) bad.push('W1 ' + id + ': header text wraps or a control hangs up to ' + widest + ' px (budget ' + budget + ')');
      for (const w of KEY.filter((x) => x > budget)) {   // widths inside the page's own (main) wrap band are reported, not asserted
        if (r[w].hh > r[1280].hh + 4) bad.push('W2 ' + id + ': header ' + r[w].hh + ' px tall at ' + w + ' vs ' + r[1280].hh + ' at 1280');
        if (r[w].hung.length) bad.push('W2 ' + id + ' @' + w + ': ' + r[w].hung.join(', ') + ' hangs below the header bar');
      }
      info.hh[id] = KEY.map((w) => w + ':' + r[w].hh).join(' ');
      for (const w of SWEEP) {
        const x = r[w];
        if (x.tels !== 1) bad.push('W3 ' + id + ' @' + w + ': ' + x.tels + ' tel links');
        const wantNum = w >= FULL_FROM;
        if (x.num !== wantNum || x.call) bad.push('W3 ' + id + ' @' + w + ': number visible=' + x.num + ' call visible=' + x.call + ', want number=' + wantNum + ' call=false');
        if (!/844 875 3412/.test(x.label || '')) bad.push('W3 ' + id + ' @' + w + ': aria-label lacks the number: ' + x.label);
      }
      if (r[768].num || !r[768].call || r[390].num || !r[390].call) bad.push('W3 ' + id + ': phone widths must show "Call" and not the number');
      if (r[769].num || r[769].call) bad.push('W3 ' + id + ': 769 must show the icon alone');
      await ctx.close();
    }
  }
  server.close();
  return { bad, info };
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const good = await sweep(browser, NAV_CSS);
const fontsOk = good.info.fonts;
if (!fontsOk && process.env.ALLOW_NO_FONTS === '1') console.log('WARN: Rubik did not load (ALLOW_NO_FONTS=1); widths are fallback-font measurements');
else ok(fontsOk, 'W4 the Rubik webfont loaded on every page (a fallback-font measurement is meaningless)');
ok(good.info.rendered === good.info.expected, 'every signed-out and signed-in page rendered its #site-header (' + good.info.rendered + '/' + good.info.expected + ')');
console.log('widest wrapped/hung width per page and state: ' + JSON.stringify(good.info.widest));
for (const id of Object.keys(good.info.hh)) console.log('  header heights ' + id + ' -> ' + good.info.hh[id]);
ok(good.bad.length === 0, 'W1-W3,W5 the real header, signed out and signed in, 769..1300 px: no wrap beyond the page budget (main), no extra row, tel link compact below ' + FULL_FROM + (good.bad.length ? ' | ' + good.bad.slice(0, 8).join(' | ') : ''));
const ctl = await sweep(browser, NAV_CSS.replace(BAND, ''), ['signed-out how-it-works', 'signed-in contractor-dashboard', 'signed-in dashboard']);
ok(ctl.bad.some((m) => /^W1 /.test(m)) && ctl.bad.some((m) => /^W2 /.test(m)) && ctl.bad.some((m) => /^W3 /.test(m)), 'NEGATIVE CONTROL (a) without the compact-band rule goes red on W1, W2 and W3 (' + ctl.bad.length + ' findings)');
const NARROW = NAV_CSS.replace('(min-width: 769px) and (max-width: 1199px)', '(min-width: 769px) and (max-width: 1099px)');
ok(NARROW !== NAV_CSS, 'negative control (b) setup: the compact band is declared as max-width 1199');
const ctl2 = await sweep(browser, NARROW, ['signed-in contractor-dashboard', 'signed-in dashboard']);
ok(ctl2.bad.some((m) => /^W1 signed-in /.test(m)), 'NEGATIVE CONTROL (b) the band at max-width 1099 (pre-M1b) goes red on W1 for a SIGNED-IN page (' + ctl2.bad.filter((m) => /^W1 signed-in /.test(m)).map((m) => m.split(':')[0].replace('W1 signed-in ', '')).join(', ') + ')');
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
