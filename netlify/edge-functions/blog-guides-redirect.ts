/**
 * blog-guides-redirect.ts — Netlify Edge Function (gh-1745, PR #1789 fix round 1)
 *
 * Intercepts the 18 extensionless /blog/ and /guides/ paths listed below and
 * 301s each to its .html twin, running AHEAD of Netlify's built-in Pretty
 * URLs post-processing.
 *
 * Why this exists on top of the `_redirects` rules already added for gh-1745:
 * a fresh-context reviewer curled all 6 intended redirects on the deploy
 * preview and got 200 on every one, never 301 (REVIEW: FAIL on PR #1789,
 * 2026-09-07). Cross-check against a structurally identical *pre-existing*
 * rule in the same file (`/partners /partners.html 301`) reproduced the
 * same failure on both the preview and production — Pretty URLs dual-serves
 * the extensionless path as its own 200 ahead of `_redirects` ever being
 * consulted. This repo has hit exactly this conflict twice before, both
 * resolved the same way, not by disabling Pretty URLs sitewide (rejected
 * both times — see the gh-1540 comment block in netlify.toml — because that
 * removes case/trailing-slash canonicalization for every other page on the
 * site to fix a handful of paths):
 *   - gh-1540: netlify/edge-functions/recruit-redirect.ts
 *   - gh-1598: netlify/edge-functions/admin-auth-gate.ts (pattern widened)
 *
 * The `_redirects` rules added for gh-1745 are left in place unchanged as
 * the documented source of truth (same convention as recruit-redirect.ts);
 * this function exists solely to win the race against Pretty URLs for
 * these 18 literal paths (gh-1745 wave 2, CRO RUN 20, widened from the
 * original 6). Everything else on the site — every other page,
 * every other `_redirects` rule — is untouched: this matches on exact
 * pathname only, no wildcard, so it cannot catch any path outside the 18
 * listed below.
 *
 * 301 (not a 200 rewrite like recruit-redirect.ts) because gh-1745 is a
 * duplicate-content / search-signal-split issue: the point is for the
 * extensionless URL to stop being independently indexable, which requires
 * search engines to see a redirect, not a second 200. Modeled on
 * ref-redirect.ts's Response.redirect() usage rather than recruit-redirect's
 * context.rewrite().
 *
 * Fail-open: if anything here throws (malformed req.url, edge runtime
 * issue), context.next() hands the request to Netlify's normal pipeline —
 * reproducing today's pre-fix behavior (a 200 on the extensionless path)
 * rather than a 500. A page that keeps 200-ing is strictly better than one
 * that errors.
 */

const REDIRECT_MAP: Record<string, string> = {
  '/blog/what-to-do-after-storm-damages-roof':
    '/blog/what-to-do-after-storm-damages-roof.html',
  '/blog/how-to-negotiate-better-roof-repair-insurance-claim':
    '/blog/how-to-negotiate-better-roof-repair-insurance-claim.html',
  '/guides/how-to-file-property-damage-claim':
    '/guides/how-to-file-property-damage-claim.html',
  '/guides/how-to-choose-contractor':
    '/guides/how-to-choose-contractor.html',
  '/guides/how-to-negotiate-with-insurer':
    '/guides/how-to-negotiate-with-insurer.html',
  '/guides/how-to-read-contractor-estimate':
    '/guides/how-to-read-contractor-estimate.html',

  // gh-1745 wave 2 (CRO RUN 20): the remaining 12 /blog/ articles that
  // had a .html twin but no entry here -- same mechanism, same reasoning
  // as the six above, extended to the full set per the CLOSE-REVIEW: FAIL
  // finding on the issue (6 of 18 content pages covered; these 12 were
  // still serving byte-identical duplicate content on both URL forms).
  '/blog/aerial-roof-measurement-reports':
    '/blog/aerial-roof-measurement-reports.html',
  '/blog/does-homeowners-insurance-cover-roof-damage':
    '/blog/does-homeowners-insurance-cover-roof-damage.html',
  '/blog/hail-vs-wind-roof-damage':
    '/blog/hail-vs-wind-roof-damage.html',
  '/blog/public-adjuster-vs-diy-roof-claim':
    '/blog/public-adjuster-vs-diy-roof-claim.html',
  '/blog/rcv-vs-acv-roof-insurance':
    '/blog/rcv-vs-acv-roof-insurance.html',
  '/blog/roof-shingle-warranty-tiers-explained':
    '/blog/roof-shingle-warranty-tiers-explained.html',
  '/blog/roofing-estimate-red-flags':
    '/blog/roofing-estimate-red-flags.html',
  '/blog/storm-chaser-roofing-scams':
    '/blog/storm-chaser-roofing-scams.html',
  '/blog/what-is-recoverable-depreciation-roofing':
    '/blog/what-is-recoverable-depreciation-roofing.html',
  '/blog/what-is-scope-of-loss-roofing':
    '/blog/what-is-scope-of-loss-roofing.html',
  '/blog/when-not-to-file-roof-insurance-claim':
    '/blog/when-not-to-file-roof-insurance-claim.html',
  '/blog/why-roofers-quote-different-prices':
    '/blog/why-roofers-quote-different-prices.html',
};

export default async (req: Request, context: any) => {
  try {
    const url = new URL(req.url);
    const target = REDIRECT_MAP[url.pathname];
    if (!target) return await context.next();

    const dest = new URL(target, url.origin);
    // Forward any incoming query string unchanged (cache-busting params,
    // utm_* tracking, etc.) — none of these pages expect query params
    // today, but there's no reason to drop them on the way to the .html twin.
    url.searchParams.forEach((value, key) => dest.searchParams.set(key, value));

    return Response.redirect(dest.toString(), 301);
  } catch {
    return await context.next();
  }
};

export const config = { path: Object.keys(REDIRECT_MAP) };
