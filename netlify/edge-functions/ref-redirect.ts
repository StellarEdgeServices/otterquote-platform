/**
 * ref-redirect.ts — Netlify Edge Function (#630)
 *
 * Intercepts /ref/:code referral short-link requests and 301-redirects to
 * /ref.html?code=:code, forwarding every other incoming query parameter
 * (utm_source, utm_medium, utm_campaign, etc.) unchanged.
 *
 * Why an edge function instead of a plain `_redirects` rule:
 * Netlify's declarative redirect engine only auto-appends the incoming
 * request's query string when the "to" target has NO query string of its
 * own. Our target must always carry `?code=`, so that auto-passthrough
 * never applies. The alternative — named `query = { key = ":value" }`
 * matching in netlify.toml/_redirects — requires every possible query key
 * to be enumerated AND the incoming request to contain exactly that set
 * (no more, no fewer), which cannot cover an open-ended set of utm_* (and
 * future) tracking params. This is a confirmed, long-standing Netlify
 * limitation (see Netlify Support Forums: "Preserve query parameters on
 * redirect", and "Keep incoming query string params and append a new
 * param during redirect"); Netlify staff's own guidance for open-ended
 * query forwarding is an Edge Function. (2026-08-06)
 *
 * Falls through via context.next() for any /ref/* path that isn't a
 * single-segment code (defensive — no other /ref/* assets exist today),
 * so behavior elsewhere is unchanged.
 */

export default async (req: Request, context: any) => {
  const url = new URL(req.url);

  // Expect exactly /ref/<code> — one path segment after /ref/
  const match = url.pathname.match(/^\/ref\/([^/]+)\/?$/);
  if (!match) return context.next();

  const code = match[1];
  const dest = new URL('/ref.html', url.origin);

  // Forward every incoming query param unchanged (utm_source, utm_medium, etc.)
  url.searchParams.forEach((value, key) => {
    dest.searchParams.set(key, value);
  });
  // The code always comes from the path segment — overrides any stray
  // ?code= that happened to also be present on the short link.
  dest.searchParams.set('code', code);

  return Response.redirect(dest.toString(), 301);
};

export const config = { path: '/ref/*' };
