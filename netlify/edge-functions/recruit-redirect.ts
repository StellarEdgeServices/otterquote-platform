/**
 * recruit-redirect.ts — Netlify Edge Function (gh-1540, REFUTED-REOPENED fix)
 *
 * Intercepts /recruit/ and /Recruit.html before Netlify's built-in Pretty
 * URLs post-processing gets a chance to 301 them. Pretty URLs normalizes
 * trailing slashes and .html-extension case *ahead of* `_redirects`, which
 * was silently defeating the existing 200-rewrite rules already in
 * `_redirects` for exactly these two path shapes (the first close on this
 * issue was refuted because the pasted evidence showed 301, not 200, for
 * both).
 *
 * /recruit and /recruit.htm are NOT touched here — they already 200
 * correctly today (neither is a shape Pretty URLs' own trailing-slash/case
 * normalization intercepts: /recruit has no trailing slash to strip, and
 * .htm isn't the real file's extension so Pretty URLs' extension-alias
 * logic never engages). The declarative `_redirects` rules for all four
 * variants (see that file's gh-1540 block) are left in place unchanged as
 * the documented source of truth; this edge function exists solely to run
 * ahead of Pretty URLs for the two shapes it was shadowing.
 *
 * A sitewide `pretty_urls = false` toggle in netlify.toml was tried first
 * and rejected on review: it silently removes Pretty URLs' case/trailing-
 * slash canonicalization for *every* page on the site, not just these two
 * (e.g. `/Bids` would then 200 duplicate-serve instead of 301-canonicalizing
 * to `/bids` — an unbounded, unaudited blast radius for a two-path fix).
 * Scoping the fix to an edge function matching only these two literal paths
 * — the same technique already used here for /admin-*.html and /ref/* —
 * keeps every other page's behavior byte-identical to today.
 *
 * context.rewrite() serves /recruit.html's content directly (200) while
 * leaving the requested URL, and its query string, untouched in the
 * browser: no redirect ever happens, so nothing can drop `?code=`.
 *
 * Fail-open (CTO condition, gh-1540 2026-09-03T22:28:49Z): this function
 * sits in front of the single highest-value entry point on the site, so a
 * throw here must never turn into a 500. If anything in the try block
 * throws — a malformed req.url, context.rewrite() erroring, the edge
 * runtime having a bad day — the catch falls through via context.next(),
 * handing the request to Netlify's normal pipeline. That reproduces
 * exactly the pre-fix behaviour these two shapes had (Pretty URLs 301s to
 * /recruit, which then 200s): one extra hop and a working page, never an
 * error. A partner link that errors is strictly worse than one that takes
 * a 301.
 */

export default async (req: Request, context: any) => {
  try {
    const url = new URL(req.url);
    const target = new URL('/recruit.html', url.origin);
    url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
    return context.rewrite(target);
  } catch {
    return context.next();
  }
};

export const config = { path: ['/recruit/', '/Recruit.html'] };
