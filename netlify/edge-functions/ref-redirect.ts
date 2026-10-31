/**
 * ref-redirect.ts — Netlify Edge Function (#630)
 *
 * Intercepts /ref/:code referral short-link requests and 302-redirects to
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
 *
 * The redirect is a 302 (not 301): a short link gains nothing from a permanent
 * redirect, and browsers cache 301s indefinitely, so a returning visitor would
 * skip this function and never get (or refresh) oq_pc.
 *
 * POST /ref-bind with a JSON body {rid, code} (called by ref.html after
 * track_referral_click succeeds; the body, not the URL, carries the rid so it
 * stays out of access logs and Referer headers): re-issues oq_pc with the referral id added
 * ({c, t, r}), keeping the ORIGINAL click time and the REMAINING lifetime, so
 * the Safari 90-day case carries the referral id the crediting path needs
 * (claims.referral_id), not just a code. The rid is NOT trusted for anything
 * beyond what the JS-written oq-ref already trusts it for: it is
 * format-checked here, bound only to an existing oq_pc for the SAME code, and
 * any value a browser can already put in oq-ref is no more powerful. No secrets
 * and no second click count (track_referral_click is still called once, by the
 * page).
 */

export const PARTNER_COOKIE_NAME = 'oq_pc';
// 90 days. Same window as REFERRAL_MAX_AGE in the two cookie-storage files once
// PR #3226 lands; kept separate here because edge functions cannot import them.
export const PARTNER_COOKIE_MAX_AGE = 60 * 60 * 24 * 90; // 7776000

// Only well-formed codes are written into a Set-Cookie header. Anything else
// still redirects exactly as before, just without the cookie.
const SAFE_CODE = /^[A-Za-z0-9_-]{1,64}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKEW_MS = 5 * 60 * 1000; // a click time more than 5 min in the future is forged

function cookieString(payload: { c: string; t: string; r?: string }, maxAge: number): string {
  const value = encodeURIComponent(JSON.stringify(payload));
  return `${PARTNER_COOKIE_NAME}=${value}; Domain=.otterquote.com; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax`;
}

export function buildPartnerCookie(code: string, now: Date = new Date()): string | null {
  if (!SAFE_CODE.test(code)) return null;
  return cookieString({ c: code, t: now.toISOString() }, PARTNER_COOKIE_MAX_AGE);
}

/** The current oq_pc from the request's Cookie header, if well-formed and in window. */
export function parseIncomingPartnerCookie(
  cookieHeader: string | null,
  nowMs: number = Date.now(),
): { c: string; t: string; ts: number } | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const trimmed = pair.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1 || trimmed.slice(0, eq) !== PARTNER_COOKIE_NAME) continue;
    try {
      const p = JSON.parse(decodeURIComponent(trimmed.slice(eq + 1)));
      const ts = typeof p?.t === "string" ? Date.parse(p.t) : NaN;
      if (typeof p?.c !== "string" || !SAFE_CODE.test(p.c) || !Number.isFinite(ts)) return null;
      if (ts > nowMs + SKEW_MS || nowMs - ts >= PARTNER_COOKIE_MAX_AGE * 1000) return null;
      return { c: p.c, t: new Date(ts).toISOString(), ts };
    } catch {
      return null;
    }
  }
  return null;
}

/** Re-issue oq_pc with the referral id, keeping the original click time and the remaining life. */
export function buildBoundPartnerCookie(
  current: { c: string; t: string; ts: number },
  rid: string,
  nowMs: number = Date.now(),
): string | null {
  if (!UUID_RE.test(rid)) return null;
  // Never more than the 90-day cap, even for a click time inside the 5-minute
  // clock-skew allowance (that would otherwise add up to 300 s).
  const remaining = Math.min(
    PARTNER_COOKIE_MAX_AGE,
    Math.ceil(PARTNER_COOKIE_MAX_AGE - (nowMs - current.ts) / 1000),
  );
  if (remaining <= 0) return null;
  return cookieString({ c: current.c, t: current.t, r: rid.toLowerCase() }, remaining);
}

async function bindResponse(req: Request): Promise<Response> {
  const headers = new Headers({ "cache-control": "no-store" });
  // POST + a custom header: a cross-site page cannot send this without a CORS
  // preflight, which this function never grants.
  if (req.method !== "POST" || req.headers.get("x-oq-bind") !== "1") {
    return new Response(null, { status: 405, headers });
  }
  let rid = "";
  let code = "";
  try {
    const raw = await req.text();
    if (raw.length > 1024) return new Response(null, { status: 413, headers });
    const body = JSON.parse(raw);
    rid = typeof body?.rid === "string" ? body.rid : "";
    code = typeof body?.code === "string" ? body.code : "";
  } catch {
    return new Response(null, { status: 400, headers });
  }
  const current = parseIncomingPartnerCookie(req.headers.get("cookie"));
  // No oq_pc (the visitor did not arrive through /ref/<code>), or it names a
  // different partner than this click: nothing to bind. Still 204, no cookie.
  if (!current || current.c !== code) return new Response(null, { status: 204, headers });
  const cookie = buildBoundPartnerCookie(current, rid);
  if (!cookie) return new Response(null, { status: 400, headers });
  headers.append("set-cookie", cookie);
  return new Response(null, { status: 204, headers });
}

export default async (req: Request, context: any) => {
  const url = new URL(req.url);

  if (url.pathname === "/ref-bind") return await bindResponse(req);

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
    // Belt and braces with the 302: never let a cache serve a redirect that
    // skips this function, or oq_pc is not refreshed (last click wins).
    headers.set('cache-control', 'no-store');
  }
  return new Response(null, { status: 302, headers });
};

export const config = { path: ['/ref/*', '/ref-bind'] };
