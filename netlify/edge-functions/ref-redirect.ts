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
 *
 * P18 server-set partner cookie: the redirect response also sets a small
 * first-party cookie `oq_pc` from the SERVER. Safari caps cookies written by
 * script (document.cookie) at 7 days, so the 90-day partner window cannot rest
 * on the JS-written `oq-ref` alone. A cookie set by an HTTP response header is
 * not subject to that cap. Partner attribution only; value is {c: code, t: ISO
 * click time}. Not HttpOnly on purpose: readReferralIds (js/cookie-storage.js
 * and react-app/app/lib/cookie-storage.ts) falls back to it when oq-ref is
 * missing or expired. Every /ref/<code> click overwrites it (last click wins).
 */

export const PARTNER_COOKIE_NAME = 'oq_pc';
// 90 days. Same window as REFERRAL_MAX_AGE in the two cookie-storage files once
// PR #3226 lands; kept separate here because edge functions cannot import them.
export const PARTNER_COOKIE_MAX_AGE = 60 * 60 * 24 * 90; // 7776000

// Only well-formed codes are written into a Set-Cookie header. Anything else
// still redirects exactly as before, just without the cookie.
const SAFE_CODE = /^[A-Za-z0-9_-]{1,64}$/;

export function buildPartnerCookie(code: string, now: Date = new Date()): string | null {
  if (!SAFE_CODE.test(code)) return null;
  const value = encodeURIComponent(JSON.stringify({ c: code, t: now.toISOString() }));
  return `${PARTNER_COOKIE_NAME}=${value}; Domain=.otterquote.com; Path=/; Max-Age=${PARTNER_COOKIE_MAX_AGE}; Secure; SameSite=Lax`;
}

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

  // Response.redirect() returns immutable headers, so build the response by hand.
  const headers = new Headers({ location: dest.toString() });
  const cookie = buildPartnerCookie(code);
  if (cookie) {
    headers.append('set-cookie', cookie);
    // A cached 301 would let a repeat click skip the server and never refresh
    // oq_pc (last click wins). The redirect target is unchanged.
    headers.set('cache-control', 'no-store');
  }
  return new Response(null, { status: 301, headers });
};

export const config = { path: '/ref/*' };
