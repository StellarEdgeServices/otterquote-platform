/**
 * Internal-Traffic Opt-Out Gate Regression Test (gh-2064 round 2).
 *
 * Round 1 (PR #2066) added `js/internal-traffic.js`, which sets
 * `window.OQ_INTERNAL`, and made `js/ga-gate.js` / `js/meta-pixel-gate.js`
 * check that flag before loading GTM/GA4, Clarity or the Meta Pixel.
 * Independent review failed the PR because internal-traffic.js was only
 * included on 10 of the 99 pages that load those gates — on the other 89,
 * including start.html and index.html, `window.OQ_INTERNAL` was never set,
 * so the opt-out was silently ignored.
 *
 * Round 2 moved the check INSIDE both gates (an `oqInternal()` function each
 * file now carries itself, reading the `oq_internal` query param / cookie
 * directly) so the opt-out no longer depends on internal-traffic.js being
 * present on the page at all. This spec proves that: it visits start.html
 * and index.html directly with NO internal-traffic.js dependency assumed,
 * plus a third page (faq.html) via a pre-set cookie instead of the query
 * param, and asserts zero requests to the three tracking hosts each gate
 * can reach (GA4/GTM, Clarity — both from ga-gate.js — and Meta — from
 * meta-pixel-gate.js). A fourth, unflagged control visit asserts gtag.js
 * IS requested, so a gate that always no-ops (fails closed for everyone,
 * not just internal traffic) would also fail this test.
 *
 * Why host-resolver-rules: both gates' ALLOWED_HOSTS check requires the
 * hostname to literally be otterquote.com/www.otterquote.com/
 * app.otterquote.com — a plain 127.0.0.1 local server never passes it, so
 * without help every visit here would already look like "blocked", making
 * this test pass even with a broken opt-out (it would prove nothing). This
 * config (internal-traffic-gate.config.ts) launches Chromium with
 * `--host-resolver-rules=MAP otterquote.com 127.0.0.1` and serves the site
 * on port 4173, then this spec navigates to `http://otterquote.com:4173/...`
 * — Chromium resolves that hostname to the local static server, and
 * `window.location.hostname` inside the page is genuinely `otterquote.com`,
 * so both gates' host allowlist passes and their real code path runs.
 */
import { test, expect, type Page } from '@playwright/test';

const TRACKING_HOST_PATTERNS: Record<string, RegExp> = {
  'googletagmanager.com (GA4/GTM)': /googletagmanager\.com/,
  'connect.facebook.net (Meta Pixel)': /connect\.facebook\.net/,
  'clarity.ms (Microsoft Clarity)': /clarity\.ms/,
};

function trackTrackingRequests(page: Page): Record<string, string[]> {
  const hits: Record<string, string[]> = {};
  for (const key of Object.keys(TRACKING_HOST_PATTERNS)) hits[key] = [];
  page.on('request', (req) => {
    const url = req.url();
    for (const [key, pattern] of Object.entries(TRACKING_HOST_PATTERNS)) {
      if (pattern.test(url)) hits[key].push(url);
    }
  });
  return hits;
}

function assertNoTrackingRequests(hits: Record<string, string[]>, context: string) {
  for (const [key, urls] of Object.entries(hits)) {
    expect(urls, `${context}: expected zero requests to ${key}, got:\n${urls.join('\n')}`).toEqual([]);
  }
}

// The two pages the round-1 review named explicitly as failing (they load
// the gates but never included internal-traffic.js).
const QUERY_PARAM_PAGES = ['/start.html', '/index.html'];

for (const path of QUERY_PARAM_PAGES) {
  test(`${path}?oq_internal=1 — zero tracking requests (opt-out via query param)`, async ({ page }) => {
    const hits = trackTrackingRequests(page);
    await page.goto(`${path}?oq_internal=1`, { waitUntil: 'networkidle' });

    const flag = await page.evaluate(() => (window as unknown as { OQ_INTERNAL?: boolean }).OQ_INTERNAL);
    expect(flag, `${path}: window.OQ_INTERNAL was not set to true`).toBe(true);

    assertNoTrackingRequests(hits, `${path}?oq_internal=1`);
  });
}

test('/faq.html — zero tracking requests (opt-out via pre-set cookie, no query param)', async ({ context, page }) => {
  // Pre-set the cookie the way a later navigation in a real walk would
  // arrive with it (round 1's whole point: the cookie persists the opt-out
  // across a walk's later clicks, which never carry ?oq_internal=1 again).
  await context.addCookies([
    {
      name: 'oq_internal',
      value: '1',
      domain: 'otterquote.com',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    },
  ]);

  const hits = trackTrackingRequests(page);
  await page.goto('/faq.html', { waitUntil: 'networkidle' });

  const flag = await page.evaluate(() => (window as unknown as { OQ_INTERNAL?: boolean }).OQ_INTERNAL);
  expect(flag, '/faq.html: window.OQ_INTERNAL was not set to true from the cookie').toBe(true);

  assertNoTrackingRequests(hits, '/faq.html (cookie-only)');
});

test('control: /index.html with no flag or cookie — gtag.js IS requested', async ({ page }) => {
  const gtagRequests: string[] = [];
  page.on('request', (req) => {
    if (/googletagmanager\.com\/gtag\/js/.test(req.url())) gtagRequests.push(req.url());
  });

  await page.goto('/index.html', { waitUntil: 'networkidle' });

  const flag = await page.evaluate(() => (window as unknown as { OQ_INTERNAL?: boolean }).OQ_INTERNAL);
  expect(flag, 'control run: window.OQ_INTERNAL should be false/undefined with no param or cookie').toBeFalsy();

  expect(
    gtagRequests.length,
    'control run: expected gtag.js to be requested on an un-flagged visit (a gate that never fires would falsely pass the opt-out tests above)'
  ).toBeGreaterThan(0);
});
