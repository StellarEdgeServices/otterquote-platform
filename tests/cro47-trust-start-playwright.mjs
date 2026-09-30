/**
 * gh-2362 (CRO47 spec section 2.5, T1 + the browser half of N1 and N5): REAL headless-Chromium proof of the /start Arm F trust
 * header on a Facebook in-app phone viewport.
 *
 * What the Node vm harness (tests/cro47-trust-start.mjs) cannot prove, this does, in a real layout engine:
 *   T1  iPhone-class viewport reduced to 390x744 (390x844 less ~100px of in-app chrome), Facebook in-app user agent
 *       (FBAN/FBIOS;FBAV), /start?v=f&fbclid=T&utm_source=facebook&utm_campaign=ho-1:
 *         - #oqTrustHeader is visible; the logo image actually loaded (naturalWidth > 0) and is not inside an <a>;
 *         - the who-we-are text equals the live partner-profile.html sentence byte-for-byte;
 *         - NO link / escape hatch is visible on the funding screen;
 *         - the FIRST funding button's bottom edge is <= 744 (above the fold);
 *         - cumulative layout shift is exactly 0;
 *         - window.__oqVariant === 'f' and the router events carry ua_context 'fb_iab';
 *         - the hidden photo slot renders nothing; the funding tap leads to the contact screen "How should we reach you?".
 *   N1  /start?v=d, /start?v=e and a bare /start: #oqTrustHeader computed display is none, <main> keeps its row layout, and the
 *       who-we-are line is not visible. Control: with the Arm-F scoping stripped from the served CSS, the same check goes RED.
 *   N5  Control: with the logo wrapped in an <a>, the T1 "logo is not a link" check goes RED.
 *
 * The page is served from THIS repo over a local HTTP server (Netlify's /start -> start.html rewrite emulated); every
 * non-local request (CDN scripts, fonts, analytics) is aborted so the run is hermetic. Playwright resolves from tests/e2e's
 * own install (the repo's existing e2e package); nothing is installed by this file.
 *
 * Run: (cd tests/e2e && npm ci) && node tests/cro47-trust-start-playwright.mjs      Exit 0 = all green.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const require = createRequire(path.join(__dirname, 'e2e', 'package.json'));
const { chromium } = require('playwright');

let pass = 0; let fail = 0;
function ok(cond, label) { if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }

const FB_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.38.108;FBBV/561012345;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.0;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]';
const VIEWPORT = { width: 390, height: 744 };
const START_HTML = fs.readFileSync(path.join(repoRoot, 'start.html'), 'utf8');
const WHO_WE_ARE = (function () {
  const profile = fs.readFileSync(path.join(repoRoot, 'partner-profile.html'), 'utf8');
  const m = /Otter Quotes connects homeowners with multiple competing\s+contractor bids for their project &mdash; free, with no obligation\./.exec(profile);
  if (!m) throw new Error('partner-profile.html who-we-are sentence not found');
  return m[0].replace(/\s+/g, ' ').replace('&mdash;', '—');
})();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.ico': 'image/x-icon' };
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/start') p = '/start.html'; // Netlify pretty-URL rewrite
      const file = path.join(repoRoot, p);
      if (!file.startsWith(repoRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function newPage(browser, base, opts) {
  opts = opts || {};
  const context = await browser.newContext({ viewport: VIEWPORT, userAgent: FB_UA, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__cls = 0;
    try { new PerformanceObserver((list) => { list.getEntries().forEach((e) => { if (!e.hadRecentInput) window.__cls += e.value; }); }).observe({ type: 'layout-shift', buffered: true }); } catch (e) { window.__cls = -1; }
  });
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== '127.0.0.1') return route.abort();
    if (opts.mutateStart && u.pathname === '/start') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: opts.mutateStart(START_HTML) });
    return route.continue();
  });
  return { page, context };
}

// The T1 checks. Returns { failed: [ids], details }.
async function t1(page, base) {
  const failed = [];
  const rec = (id, cond, label) => { ok(cond, 'T1: ' + label); if (!cond) failed.push(id); };
  await page.goto(base + '/start?v=f&fbclid=T&utm_source=facebook&utm_campaign=ho-1', { waitUntil: 'load' });
  await page.waitForSelector('#routerFRoot h1');
  await page.waitForTimeout(1500); // let the router JS hydrate and any late shift happen
  const m = await page.evaluate(() => {
    const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
    const hdr = document.getElementById('oqTrustHeader');
    const logo = document.getElementById('oqTrustLogo');
    const photo = document.getElementById('oqTrustPhoto');
    const firstBtn = document.querySelector('#routerFRoot .role-option');
    const line = hdr && hdr.querySelector('.oq-trust-line');
    const events = Array.from(window.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event' && a[1] === 'router_step_view');
    const links = Array.from(document.querySelectorAll('a')).filter(vis).map((a) => a.outerHTML.slice(0, 80));
    return {
      hdrVisible: vis(hdr), hdrBottom: hdr ? hdr.getBoundingClientRect().bottom : null, hdrHeight: hdr ? hdr.getBoundingClientRect().height : null,
      logoLoaded: !!logo && logo.complete && logo.naturalWidth > 0, logoInLink: !!(logo && logo.closest('a')),
      logoRect: logo ? [logo.getBoundingClientRect().width, logo.getBoundingClientRect().height] : null,
      lineText: line ? line.textContent.replace(/\s+/g, ' ').trim() : null,
      photoRenders: vis(photo), links,
      firstBtnBottom: firstBtn ? firstBtn.getBoundingClientRect().bottom : null,
      cls: window.__cls, variant: window.__oqVariant, viewEvents: events.map((a) => ({ step: a[2].step, ua: a[2].ua_context, variant: a[2].variant })),
      rowLayout: getComputedStyle(document.querySelector('main')).flexDirection,
      innerHeight: window.innerHeight, docHeight: document.documentElement.scrollHeight
    };
  });
  console.log('     measured: ' + JSON.stringify({ hdrHeight: m.hdrHeight, hdrBottom: m.hdrBottom, logoRect: m.logoRect, firstBtnBottom: m.firstBtnBottom, cls: m.cls, innerHeight: m.innerHeight, ua: m.viewEvents.map((e) => e.ua).join(',') }));
  rec('visible', m.hdrVisible, '#oqTrustHeader is visible on /start?v=f in the Facebook in-app UA at 390x744');
  rec('logo-loaded', m.logoLoaded, 'the logo image loaded (naturalWidth > 0)');
  rec('logo-not-link', !m.logoInLink, 'the logo is NOT inside an <a>');
  rec('who-we-are', m.lineText === WHO_WE_ARE, 'the who-we-are text equals the live partner-profile.html sentence byte-for-byte');
  // gh-1925 (Ben ruling 5896607701): the ONE legally required CPRA opt-out link is the only link Arm F may show.
  const nonDnsLinks = m.links.filter((l) => l.indexOf('id="footer-do-not-sell-link-armf"') === -1);
  rec('no-links', nonDnsLinks.length === 0, 'NO link other than the ruled Do Not Sell or Share link is visible anywhere on the funding screen (visible links: ' + JSON.stringify(m.links) + ')');
  rec('dns-link-only', m.links.length - nonDnsLinks.length === 1, 'exactly one Do Not Sell or Share link is visible on Arm F (gh-1925)');
  rec('photo-hidden', !m.photoRenders, 'the photo slot renders nothing (hidden until Dustin supplies the file)');
  rec('above-fold', m.firstBtnBottom !== null && m.firstBtnBottom <= 744, 'the first funding button bottom edge is <= 744px (measured ' + m.firstBtnBottom + ')');
  rec('header-height', m.hdrHeight !== null && m.hdrHeight <= 72, 'the trust block is <= 72px tall (measured ' + (m.hdrHeight && m.hdrHeight.toFixed(1)) + ')');
  rec('cls-zero', m.cls === 0, 'cumulative layout shift is exactly 0 (measured ' + m.cls + ')');
  rec('variant-f', m.variant === 'f', "window.__oqVariant === 'f'");
  rec('ua-context', m.viewEvents.length >= 1 && m.viewEvents.every((e) => e.ua === 'fb_iab' && e.variant === 'f'), "router_step_view events carry ua_context 'fb_iab' and variant f");
  return { failed, m };
}

async function n1(page, base, label, qs) {
  await page.goto(base + '/start' + qs, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => {
    const hdr = document.getElementById('oqTrustHeader');
    const rect = hdr.getBoundingClientRect();
    return { display: getComputedStyle(hdr).display, w: rect.width, h: rect.height, main: getComputedStyle(document.querySelector('main')).flexDirection, arm: document.documentElement.getAttribute('data-oq-start-arm') };
  });
  return r.display === 'none' && r.w === 0 && r.h === 0 && r.main === 'row' && r.arm !== 'f';
}

async function main() {
  const server = await serve();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  try {
    console.log('=== T1: /start?v=f in a Facebook in-app UA, 390x744 ===');
    {
      const { page, context } = await newPage(browser, base);
      const r = await t1(page, base);
      ok(r.failed.length === 0, 'T1 is fully green on the real page (failed: ' + r.failed.join(',') + ')');
      await page.screenshot({ path: process.env.CRO47_SHOT || path.join(process.env.TEMP || '.', 'cro47-arm-f-390x744.png') });
      // The funding tap leads to the contact screen with the new headline.
      await page.click('#routerFRoot .role-option');
      await page.waitForSelector('#rfName');
      const h1 = await page.textContent('#routerFRoot h1');
      ok(h1 === 'How should we reach you?', 'after the funding tap the screen is the CONTACT screen headed "How should we reach you?" (' + h1 + ')');
      ok((await page.$('#rfAddress')) === null, 'the contact screen has no address field in the real DOM');
      await context.close();
    }

    console.log('\n=== F1: the logo file is requested exactly once on ?v=f and never on d / e / bare /start ===');
    for (const [qs, want] of [['?v=f', 1], ['?v=d', 0], ['?v=e', 0], ['', 0]]) {
      const { page, context } = await newPage(browser, base);
      const reqs = [];
      page.on('request', (r) => { if (/otter-quotes-icon-512\.png/.test(r.url())) reqs.push(r.url()); });
      await page.goto(base + '/start' + qs, { waitUntil: 'load' });
      await page.waitForTimeout(1200);
      ok(reqs.length === want, 'F1: /start' + qs + ' requests the logo PNG ' + want + ' time(s) (saw ' + reqs.length + ')');
      await context.close();
    }
    {
      const { page, context } = await newPage(browser, base, { mutateStart: (h) => h.replace('<img id="oqTrustLogo" data-src=', '<img id="oqTrustLogo" src=') });
      const reqs = [];
      page.on('request', (r) => { if (/otter-quotes-icon-512\.png/.test(r.url())) reqs.push(r.url()); });
      await page.goto(base + '/start?v=d', { waitUntil: 'load' });
      await page.waitForTimeout(1200);
      ok(reqs.length >= 1, 'F1 control: with a src in the markup (the pre-fix shape) /start?v=d DOES request the logo, so the zero above is meaningful');
      await context.close();
    }

    console.log('\n=== N1: arms D/E and a bare /start never show the header ===');
    for (const [label, qs] of [['?v=d', '?v=d'], ['?v=e', '?v=e'], ['bare /start', '']]) {
      const { page, context } = await newPage(browser, base);
      ok(await n1(page, base, label, qs), 'N1: /start' + qs + ' -> #oqTrustHeader display:none, zero size, <main> row layout, no Arm F attribute');
      await context.close();
    }
    {
      const { page, context } = await newPage(browser, base, { mutateStart: (h) => h.split('html[data-oq-start-arm="f"] #oqTrustHeader { display: block;').join('#oqTrustHeader { display: block;') });
      const green = await n1(page, base, 'mutated ?v=d', '?v=d');
      ok(green === false, 'N1 control: with the Arm-F scoping stripped from the CSS, the arm D check goes RED (header leaks)');
      await context.close();
    }

    console.log('\n=== D1 (gh-1925): the Do Not Sell or Share link is visible once on every arm (Arm F: own element; A-E: nav.js footer) ===');
    {
      const dnsState = async (qs, opts) => {
        const { page, context } = await newPage(browser, base, opts);
        await page.goto(base + '/start' + qs, { waitUntil: 'load' });
        await page.waitForTimeout(1500);
        const r = await page.evaluate(() => {
          const vis = (e) => { const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && e.getClientRects().length > 0; };
          const all = Array.from(document.querySelectorAll('a')).filter((a) => a.textContent.trim() === 'Do Not Sell or Share My Personal Information');
          return { visible: all.filter(vis).length, total: all.length, armFVisible: !!document.getElementById('oq-armf-dns') && vis(document.getElementById('oq-armf-dns')) };
        });
        await context.close();
        return r;
      };
      const f = await dnsState('?v=f', undefined);
      ok(f.visible === 1 && f.armFVisible, 'D1: /start?v=f shows exactly one Do Not Sell or Share link, the Arm F element (' + JSON.stringify(f) + ')');
      for (const qs of ['?v=d', '?v=e', '']) {
        const r = await dnsState(qs, undefined);
        ok(r.visible === 1 && !r.armFVisible, 'D1: /start' + qs + ' shows exactly one link (nav.js footer) and the Arm F element stays hidden -- no duplicate (' + JSON.stringify(r) + ')');
      }
      const c = await dnsState('?v=d', { mutateStart: (h) => h.split('html[data-oq-start-arm="f"] #oq-armf-dns { display: block;').join('#oq-armf-dns { display: block;') });
      ok(c.visible !== 1 || c.armFVisible, 'D1 control: with the Arm-F scoping stripped from the CSS the arm D check goes RED (duplicate link leaks) (' + JSON.stringify(c) + ')');
    }

    console.log('\n=== N5 control: the logo wrapped in an <a> ===');
    {
      const { page, context } = await newPage(browser, base, { mutateStart: (h) => h.replace('<img id="oqTrustLogo"', '<a href="/"><img id="oqTrustLogo"').replace('alt="Otter Quotes" decoding="async">', 'alt="Otter Quotes" decoding="async"></a>') });
      const origLog = console.log; const quiet = []; console.log = (s) => quiet.push(s);
      let r; try { r = await t1(page, base); } finally { console.log = origLog; }
      pass -= quiet.filter((s) => /^PASS/.test(s)).length; fail -= quiet.filter((s) => /^FAIL/.test(s)).length; // the mutated run's own lines do not count
      ok(r.failed.indexOf('logo-not-link') !== -1, 'N5: wrapping the logo in an <a> turns T1 RED (failed checks: ' + r.failed.join(',') + ')');
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log('\n=== Summary ===\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('UNCAUGHT:', e); process.exit(1); });
