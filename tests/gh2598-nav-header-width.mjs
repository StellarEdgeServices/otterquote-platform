/**
 * gh-2598 slice 4 -- RENDERED-WIDTH check for the shared header (REVIEW FAIL 6200529604, M1; the markup test gh2598-nav-header-footer.mjs cannot see crowding).
 *
 * The header tel link crowded the shared header and wrapped the brand and nav labels from 769 to 1059 px (production wraps only to 889). This runs the REAL pages in
 * headless Chromium over a local static server, with the real Rubik webfont loaded (fonts.googleapis.com / fonts.gstatic.com are the only third-party hosts allowed),
 * the signed-out auth buttons rendered by Nav's own _guestAuthHTML (same markup the live auth slot gets), and sweeps 769..1300 px:
 *
 *   W1  no header text wraps at 890 px or wider, on index, how-it-works, login, partner-re, contractor-dashboard (role-matched guest buttons) and admin-contractors
 *       (the budget is production's widest wrap band, 889 px; the PR must never exceed it)
 *   W2  at 900, 1024, 1059, 1100 and 1280 (all beyond production's own wrap band) no header control (link or button) hangs below the 64 px bar (the reviewer saw "Log In" stack under it at 1024) and the header is no taller than at 1280
 *   W3  the tel link: full number from 1100 px up, icon alone (aria-label carries the number) at 769-1099, "Call" at <= 768; always one tel:+18448753412 link
 *   W4  the Rubik font really loaded (a fallback-font measurement is meaningless); ALLOW_NO_FONTS=1 downgrades this to a warning for offline runs
 *   Negative control: the same sweep against nav.css with the compact-band rule removed (the pre-fix PR CSS) must FAIL W1, W2 and W3.
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

const BUDGET = 889;                       // production's widest wrap band (index, how-it-works, login)
const PAGES = ['index', 'how-it-works', 'login', 'admin-contractors', 'partner-re', 'contractor-dashboard'];
const SWEEP = []; for (let w = 769; w <= 1300; w += 10) SWEEP.push(w);
const KEY = [820, 900, 1024, 1059, 1100, 1280]; for (const w of KEY) if (!SWEEP.includes(w)) SWEEP.push(w);
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

async function sweep(browser, navCss) {
  const server = await serve(navCss); const base = 'http://127.0.0.1:' + server.address().port;
  const bad = [], info = { fonts: true, widest: {}, hh: {} };
  for (const pg of PAGES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.route('**/*', (r) => { const u = new URL(r.request().url()); return (u.hostname === '127.0.0.1' || /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(u.hostname)) ? r.continue() : r.abort(); });
    await page.goto(base + '/' + pg + '.html', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForSelector('#site-header .nav-phone', { timeout: 15000 }).catch(() => {});
    // The signed-out auth buttons, from Nav's own markup (the live slot is filled by Auth and needs the network).
    await page.evaluate(() => {
      const slot = document.getElementById('nav-auth-slot');
      if (slot && !slot.children.length) slot.innerHTML = Nav._guestAuthHTML(Nav._activeRole || Nav._resolveRole()).desktop;
    }).catch(() => {});
    await page.evaluate(() => document.fonts.load('500 16px Rubik').then(() => document.fonts.ready)).catch(() => {});
    const font = await page.evaluate(() => [...document.fonts].some((f) => f.family.includes('Rubik') && f.status === 'loaded')).catch(() => false);
    if (!font) info.fonts = false;
    const r = {};
    for (const w of [390, 768, 769, ...SWEEP]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(80);
      r[w] = await page.evaluate(probe);
    }
    const none = r[1280].none;
    if (none) { bad.push(pg + ': no #site-header rendered'); await ctx.close(); continue; }
    const widest = Math.max(0, ...SWEEP.filter((w) => r[w].wrapped.length).map((w) => w));
    info.widest[pg] = widest;
    if (widest > BUDGET) bad.push('W1 ' + pg + ': header text wraps up to ' + widest + ' px (budget ' + BUDGET + ')');
    for (const w of KEY.filter((x) => x > BUDGET)) {   // 820 sits inside production's own wrap band, so it is reported, not asserted
      if (r[w].hh > r[1280].hh + 4) bad.push('W2 ' + pg + ': header ' + r[w].hh + ' px tall at ' + w + ' vs ' + r[1280].hh + ' at 1280');
      if (r[w].hung.length) bad.push('W2 ' + pg + ' @' + w + ': ' + r[w].hung.join(', ') + ' hangs below the header bar');
    }
    info.hh[pg] = KEY.map((w) => w + ':' + r[w].hh).join(' ');
    for (const w of SWEEP) {
      const x = r[w];
      if (x.tels !== 1) bad.push('W3 ' + pg + ' @' + w + ': ' + x.tels + ' tel links');
      const wantNum = w >= 1100;
      if (x.num !== wantNum || x.call) bad.push('W3 ' + pg + ' @' + w + ': number visible=' + x.num + ' call visible=' + x.call + ', want number=' + wantNum + ' call=false');
      if (!/844 875 3412/.test(x.label || '')) bad.push('W3 ' + pg + ' @' + w + ': aria-label lacks the number: ' + x.label);
    }
    if (r[768].num || !r[768].call || r[390].num || !r[390].call) bad.push('W3 ' + pg + ': phone widths must show "Call" and not the number');
    if (r[769].num || r[769].call) bad.push('W3 ' + pg + ': 769 must show the icon alone');
    await ctx.close();
  }
  server.close();
  return { bad, info };
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const good = await sweep(browser, NAV_CSS);
const fontsOk = good.info.fonts;
if (!fontsOk && process.env.ALLOW_NO_FONTS === '1') console.log('WARN: Rubik did not load (ALLOW_NO_FONTS=1); widths are fallback-font measurements');
else ok(fontsOk, 'W4 the Rubik webfont loaded on every page (a fallback-font measurement is meaningless)');
ok(Object.keys(good.info.widest).length === PAGES.length, 'every page rendered a #site-header (' + PAGES.length + ')');
console.log('widest wrapped width per page: ' + JSON.stringify(good.info.widest));
for (const pg of PAGES) console.log('  header heights ' + pg + ' -> ' + good.info.hh[pg]);
ok(good.bad.length === 0, 'W1-W3 the real header at 769..1300 px: no wrap beyond ' + BUDGET + ', no extra row, tel link compact below 1100' + (good.bad.length ? ' | ' + good.bad.slice(0, 8).join(' | ') : ''));
const ctl = await sweep(browser, NAV_CSS.replace(BAND, ''));
ok(ctl.bad.some((m) => /^W1 /.test(m)) && ctl.bad.some((m) => /^W2 /.test(m)) && ctl.bad.some((m) => /^W3 /.test(m)), 'NEGATIVE CONTROL without the compact-band rule goes red on W1, W2 and W3 (' + ctl.bad.length + ' findings)');
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
