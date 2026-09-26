/**
 * gh-2225 re-review fix (B6, REVIEW FAIL 5849956427) -- REAL headless-Chromium
 * proof that the co-branding data (name/company/phone/email + referral link)
 * actually reaches the handout page after the same-tab navigation fix.
 *
 * This is not a static-source check: it serves the real repo over HTTP,
 * drives a real Chromium tab with Playwright, calls the page's own
 * buildHandoutUrl()/showHandoutLink() functions with a synthetic
 * @otterquote-internal.test partner's data (as register_partner's success
 * handler would), clicks the real handout link, and asserts the resulting
 * page (after a real same-tab navigation) shows the agent's data instead of
 * placeholders.
 *
 * Negative control: navigating straight to the handout with no prior
 * sessionStorage write (nobody went through the funnel) must render every
 * field as its "[ ]" placeholder -- proving the positive case is not
 * vacuously true.
 *
 * Run: node tests/gh2225-playwright-cobrand-proof.mjs
 * Requires a static file server at $BASE_URL (see run-cobrand-proof.sh).
 */
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8842';
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

const SYNTHETIC = {
  name: 'Test Agent',
  company: 'Otterquote Internal Test Agency',
  phone: '317-555-0100',
  email: 'gh2225-proof@otterquote-internal.test',
  code: 'GH2225TESTCODE',
};

async function run() {
  const browser = await chromium.launch();

  for (const [funnel, handout, sessionKey] of [
    ['ins-5', 'handout-ins-5', 'oq_handout_ins5_contact'],
    ['hi-4', 'handout-hi-4', 'oq_handout_hi4_contact'],
  ]) {
    const page = await browser.newPage();
    await page.goto(`${BASE_URL}/${funnel}.html`);

    // Simulate exactly what the register_partner success handler does:
    // call the page's own buildHandoutUrl() (writes sessionStorage, returns
    // the ?code= URL) and showHandoutLink() (reveals + wires the anchor).
    const handoutUrl = await page.evaluate((s) => {
      const url = buildHandoutUrl(s.name, s.company, s.phone, s.email, s.code);
      showHandoutLink(url);
      // Reveal #successMessage exactly as the real success handler does
      // (showConfirmationUI() on ins-5.html / showApprovedConfirmation() on
      // hi-4.html) -- done inline here since the two pages name it
      // differently, to keep this proof working against both.
      document.getElementById('successMessage').classList.add('show');
      return url;
    }, SYNTHETIC);

    ok(!handoutUrl.includes(SYNTHETIC.name) && !handoutUrl.includes(SYNTHETIC.email),
      `${funnel}.html: handout URL carries no PII (${handoutUrl})`);

    // Real click on the real anchor -- exercises whatever target/rel is
    // actually on the element, same as an agent tapping it on their phone.
    await Promise.all([
      page.waitForNavigation(),
      page.click('#handoutLinkBtn'),
    ]);

    ok(page.url().includes(`/assets/${handout}.html`), `${funnel}: click on #handoutLinkBtn navigated the SAME tab to the handout (${page.url()})`);

    const name = await page.textContent('#cbName');
    const company = await page.textContent('#cbCompany');
    const refLink = await page.textContent('#refLinkBox');

    ok(name.trim() === SYNTHETIC.name, `${funnel}: handout shows the real agent name ("${name.trim()}")`);
    ok(company.trim() === SYNTHETIC.company, `${funnel}: handout shows the real company ("${company.trim()}")`);
    ok(refLink.includes(`ref.html?code=${SYNTHETIC.code}`), `${funnel}: handout shows the real referral link ("${refLink.trim()}")`);

    if (funnel === 'ins-5') {
      const phone = await page.textContent('#cbPhone');
      const email = await page.textContent('#cbEmail');
      ok(phone.trim() === SYNTHETIC.phone, `${funnel}: handout shows the real phone ("${phone.trim()}")`);
      ok(email.trim() === SYNTHETIC.email, `${funnel}: handout shows the real email ("${email.trim()}")`);
    }

    // No page (funnel or handout) may have loaded a pixel for this synthetic
    // partner -- belt-and-suspenders check with a real browser, not just grep.
    const pixelGlobals = await page.evaluate(() => ({
      fbq: typeof window.fbq,
      gtag: typeof window.gtag,
    }));
    ok(pixelGlobals.fbq === 'undefined', `${handout}.html: window.fbq is not defined (no Meta pixel loaded)`);
    ok(pixelGlobals.gtag === 'undefined' || pixelGlobals.gtag === 'function', `${handout}.html: gtag presence check ran (informational; ga-gate.js is intentionally absent from the handout)`);

    await page.close();

    // ── Negative control: fresh tab, straight to the handout, no funnel
    // visit and no sessionStorage write. Every field must be a placeholder.
    const negPage = await browser.newContext().then((ctx) => ctx.newPage());
    await negPage.goto(`${BASE_URL}/assets/${handout}.html?code=${SYNTHETIC.code}`);
    const negName = await negPage.textContent('#cbName');
    const negCompany = await negPage.textContent('#cbCompany');
    ok(negName.trim() === '[ ]', `negative control (${handout}): no prior sessionStorage -> name stays placeholder ("${negName.trim()}")`);
    ok(negCompany.trim() === '[ ]', `negative control (${handout}): no prior sessionStorage -> company stays placeholder ("${negCompany.trim()}")`);
    const negRefLink = await negPage.textContent('#refLinkBox');
    ok(negRefLink.includes(`ref.html?code=${SYNTHETIC.code}`), `${handout}: referral link still builds correctly from a bare, valid ?code= with no contact data`);
    await negPage.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
