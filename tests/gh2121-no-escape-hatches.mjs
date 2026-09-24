/**
 * gh-2121 (LRS S07): "no escape hatches before conversion" on /start.
 *
 * ceo67 audit finding: the header logo (-> /index.html) and the full
 * footer nav (How It Works / FAQ / Get Started / Blog) both rendered live
 * on /start; #2118 only closed the audience-role-pill class of this same
 * bug. This test renders the REAL page in a real headless browser (not a
 * source-regex check -- nav.js builds the header/footer via client-side
 * innerHTML, so a static-HTML read would show neither element's content)
 * and asserts that, before the visitor reaches screen 4 (thank you), no
 * visible <a href> can carry them off Arm F -- with the one explicit,
 * required exception: the Privacy Policy / Terms links the approved
 * consent copy requires on screen 3 (arm_f_s3_privacy_line, js/router-
 * variant-f.js) must still exist, still point at privacy.html/terms.html,
 * and still open in the SAME tab (spec 8: no new tabs in the FB/IG
 * in-app browsers).
 *
 * gh-2160 review fix (comment 5818464392, must-fix 1): the original PR's
 * header/footer skip was scoped to the WHOLE PAGE, not just Arm F -- C, D
 * and E (the live random split) lost their footer Privacy Policy/Terms
 * links along with the escape hatches. This file now also asserts arms
 * c/d/e keep the header AND footer built exactly as before, including the
 * footer's own Privacy Policy/Terms links -- see assertArmKeepsFooterLegal
 * below.
 *
 * NEGATIVE CONTROL: the same check also runs against a second server
 * (PRIOR_BASE_URL) serving the pre-gh-2121 start.html/nav.js (git HEAD, the
 * commit before this PR's fix) and asserts it FAILS the exact same
 * assertion -- proving this check catches the bug it claims to catch, not
 * just a check that always passes. See the PR/report for how that second
 * tree is built (`git show HEAD:start.html` / `HEAD:js/nav.js`, everything
 * else symlinked back to the real repo).
 *
 * Requires: a static file server for the repo root (fixed) and one for the
 * pre-fix tree, and a Chrome binary.
 *   BASE_URL=http://127.0.0.1:8899 PRIOR_BASE_URL=http://127.0.0.1:8898 \
 *   CHROME_PATH=/path/to/chrome node tests/gh2121-no-escape-hatches.mjs
 */
import puppeteer from 'puppeteer-core';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8899';
const PRIOR_BASE_URL = process.env.PRIOR_BASE_URL || '';
const CHROME_PATH = process.env.CHROME_PATH;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('PASS: ' + label); }
  else { fail++; console.log('FAIL: ' + label); }
}

// Allowed exit links: the legal-copy-required privacy/terms links (screen 3
// consent line), and the harmless in-page "#" no-op some sign-out buttons
// use (never present pre-conversion on /start -- checked separately below,
// not allowlisted blind).
const ALLOWED_HREFS = new Set(['privacy.html', 'terms.html', '/privacy.html', '/terms.html']);

async function findEscapeHatches(page, variant, base) {
  const url = `${base || BASE_URL}/start.html?v=${variant}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  // Let the dynamically-injected arm script (js/router-variant-f.js etc.)
  // finish rendering screen 1.
  await new Promise((r) => setTimeout(r, 500));

  return page.evaluate((allowedArr) => {
    const allowed = new Set(allowedArr);
    function isVisible(el) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      // walk ancestors -- an <a> inside a display:none header/footer must
      // not count even if its OWN computed style looks fine in isolation
      let node = el;
      while (node) {
        const s = getComputedStyle(node);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        node = node.parentElement;
      }
      return true;
    }
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const escapes = [];
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (!href || href === '#' || href.indexOf('javascript:') === 0) continue;
      if (allowed.has(href)) continue;
      if (!isVisible(a)) continue; // hidden (e.g. display:none header/footer) can't be tapped or tabbed to
      escapes.push({ href, text: (a.textContent || '').trim().slice(0, 40), id: a.id, cls: a.className });
    }
    return escapes;
  }, Array.from(ALLOWED_HREFS));
}

async function findConsentLinks(page) {
  // Drive to screen 3 (contact/consent) via the funding tap + address fill,
  // the same path a real Arm F visitor takes, so the privacy/terms links
  // are confirmed present WHERE the copy puts them, not merely somewhere
  // in the DOM.
  return page.evaluate(() => {
    const root = document.getElementById('routerFRoot');
    if (!root) return null;
    const links = Array.from(root.querySelectorAll('a[href]'))
      .filter((a) => /privacy\.html|terms\.html/.test(a.getAttribute('href') || ''))
      .map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), text: (a.textContent || '').trim() }));
    return links;
  });
}

// gh-2160 review fix (must-fix 1): confirms arm `variant` keeps its header
// AND footer built exactly as main -- in particular the footer's own
// Privacy Policy / Terms links, which is the specific regression the
// review caught (data-skip-nav / the display:none rule were page-wide, not
// Arm-F-scoped, in the original PR).
async function assertArmKeepsFooterLegal(page, variant, base) {
  const url = `${base || BASE_URL}/start.html?v=${variant}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 500));
  const result = await page.evaluate(() => {
    const h = document.getElementById('site-header');
    const f = document.getElementById('site-footer');
    const footerLinks = f
      ? Array.from(f.querySelectorAll('a[href]')).map((a) => (a.getAttribute('href') || ''))
      : [];
    return {
      headerHTML: h ? h.innerHTML.trim() : null,
      footerHTML: f ? f.innerHTML.trim() : null,
      hasPrivacy: footerLinks.some((href) => /(^|\/)privacy\.html$/.test(href)),
      hasTerms: footerLinks.some((href) => /(^|\/)terms\.html$/.test(href))
    };
  });
  ok(!!result.headerHTML, 'arm ' + variant + ': #site-header was built (NOT skipped) -- matches main');
  ok(!!result.footerHTML, 'arm ' + variant + ': #site-footer was built (NOT skipped) -- matches main');
  ok(result.hasPrivacy, 'arm ' + variant + ': footer keeps its Privacy Policy link');
  ok(result.hasTerms, 'arm ' + variant + ': footer keeps its Terms of Service link');
}

async function main() {
  const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-gpu'] };
  if (CHROME_PATH) launchOpts.executablePath = CHROME_PATH;
  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

    // ─── Screen 1 (funding tap not yet made): the state every /start?v=f
    // ad click lands in first. ───
    const screen1Escapes = await findEscapeHatches(page, 'f');
    ok(Array.isArray(screen1Escapes), 'screen 1 render completed without throwing');
    ok(screen1Escapes.length === 0,
      'screen 1: no visible <a href> leaves /start before conversion' +
      (screen1Escapes.length ? ' -- FOUND: ' + JSON.stringify(screen1Escapes) : ''));

    // ─── Header/footer specifically: not merely hidden, not BUILT (the
    // stronger of the two fixes -- also the perf win, see PR). ───
    const headerFooterEmpty = await page.evaluate(() => {
      const h = document.getElementById('site-header');
      const f = document.getElementById('site-footer');
      return { headerHTML: h ? h.innerHTML.trim() : null, footerHTML: f ? f.innerHTML.trim() : null };
    });
    ok(headerFooterEmpty.headerHTML === '', 'header #site-header was never populated on Arm F (data-skip-nav honored)');
    ok(headerFooterEmpty.footerHTML === '', 'footer #site-footer was never populated on Arm F (data-skip-nav honored)');

    // ─── gh-2160 review fix (must-fix 1): arms C, D, E (the live random
    // split) and a bare /start (no ?v=) must keep the header/footer -- and
    // specifically the footer's Privacy Policy/Terms links -- exactly as
    // main. ───
    await assertArmKeepsFooterLegal(page, 'c');
    await assertArmKeepsFooterLegal(page, 'd');
    await assertArmKeepsFooterLegal(page, 'e');
    {
      const url = `${BASE_URL}/start.html`;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise((r) => setTimeout(r, 500));
      const bare = await page.evaluate(() => {
        const h = document.getElementById('site-header');
        const f = document.getElementById('site-footer');
        return { headerHTML: h ? h.innerHTML.trim() : null, footerHTML: f ? f.innerHTML.trim() : null };
      });
      ok(!!bare.headerHTML, 'bare /start (no live-arm hint): #site-header was built -- matches main');
      ok(!!bare.footerHTML, 'bare /start (no live-arm hint): #site-footer was built -- matches main');
    }

    // ─── Drive to screen 3 and confirm the required legal links survived,
    // same tab, correct hrefs -- the explicit exception, not an oversight. ───
    // Re-navigate to Arm F: the arm c/d/e/bare checks just above left the
    // page on a different arm entirely.
    await page.goto(`${BASE_URL}/start.html?v=f`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 500));
    // Screen 1: tap the funding question (first role-option-style button).
    const advanced = await page.evaluate(() => {
      const root = document.getElementById('routerFRoot');
      if (!root) return false;
      const btn = root.querySelector('button, .role-option');
      if (!btn) return false;
      btn.click();
      return true;
    });
    ok(advanced, 'screen 1 -> 2: funding tap advanced the flow');
    await new Promise((r) => setTimeout(r, 200));
    // Screen 2: fill address, submit.
    await page.evaluate(() => {
      const root = document.getElementById('routerFRoot');
      const input = root && root.querySelector('input');
      if (input) {
        input.value = '123 Main St, Indianapolis, IN';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const buttons = root ? Array.from(root.querySelectorAll('button')) : [];
      const btn = buttons[buttons.length - 1]; // primary "Continue" is appended LAST, after the back button
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 300));

    const consentLinks = await findConsentLinks(page);
    ok(Array.isArray(consentLinks) && consentLinks.length === 2,
      'screen 3: exactly 2 legal links present (Privacy Policy, Terms) -- got ' + JSON.stringify(consentLinks));
    if (consentLinks) {
      ok(consentLinks.every((l) => /^(privacy|terms)\.html$/.test(l.href)),
        'screen 3: legal links point at privacy.html / terms.html unchanged');
      ok(consentLinks.every((l) => l.target !== '_blank'),
        'screen 3: legal links open in the SAME tab (spec 8: no new tabs in FB/IG in-app browsers)');
    }

    // ─── NEGATIVE CONTROL ───
    // Confirm this check actually catches the pre-fix bug, not just a
    // check that always passes: same assertion, same code path, against a
    // server serving the pre-gh-2121 start.html/nav.js (git HEAD).
    if (PRIOR_BASE_URL) {
      const priorEscapes = await findEscapeHatches(page, 'f', PRIOR_BASE_URL);
      const priorHeaderFooter = await page.evaluate(() => {
        const h = document.getElementById('site-header');
        const f = document.getElementById('site-footer');
        return { headerHTML: h ? h.innerHTML.trim() : null, footerHTML: f ? f.innerHTML.trim() : null };
      });
      ok(priorEscapes.length > 0,
        'NEGATIVE CONTROL: the PRE-FIX build fails this exact check -- found ' +
        priorEscapes.length + ' escape hatch(es): ' + JSON.stringify(priorEscapes));
      ok(priorHeaderFooter.headerHTML !== '' && priorHeaderFooter.footerHTML !== '',
        'NEGATIVE CONTROL: the PRE-FIX build DID populate header/footer on /start (confirms data-skip-nav is what changed)');
    } else {
      console.log('SKIPPED: negative control (PRIOR_BASE_URL not set)');
    }

    console.log('\n=== Summary ===\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error('UNCAUGHT:', e); process.exit(1); });
