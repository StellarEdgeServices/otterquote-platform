/**
 * gh-1983 — first-touch ad attribution, pure core (no DOM, no imports).
 *
 * Shared by three runtimes, so it must stay dependency-free:
 *   - the React app (react-app/app/lib/attribution.ts, via `@/lib/...`)
 *   - Next.js middleware on app.otterquote.com (react-app/middleware.ts)
 *   - the Netlify edge function on otterquote.com
 *     (netlify/edge-functions/first-touch-attribution.ts, relative `.ts` import)
 *
 * Semantics (gh-3002): FIRST TOUCH, tagged or not. The first landing creates
 * the record (landing path + referrer host + time) whether or not the URL
 * carries a tracked key (utm_source/medium/campaign/content/term, fbclid,
 * gclid); an organic visit therefore still traces to the page it entered on.
 * Until gh-3002 an untagged visit recorded nothing, which left 24 of 25
 * post-#1983 signups with no landing path at all. A record is never replaced
 * by a later touch (callers check first), tagged or not: the stored landing
 * path and time are the true first page. Consequence: a visitor whose first
 * page was organic and who later clicks an ad is NOT re-credited to the ad.
 * UNTAGGED capture (only) is skipped for a visitor who has opted out of ad
 * sharing (Sec-GPC: 1 or the oq_ad_optout=1 cookie, privacy policy s12, D-336
 * and D-354); tagged capture is unchanged from #1983.
 *
 * Privacy: only the landing PATH is kept (never the query string or fragment —
 * implicit-flow OAuth puts tokens in the fragment, see gh-1969) and only the
 * referrer HOST. Values are printable ASCII, trimmed, length-capped.
 */

export const FT_COOKIE = 'oq_ft';
export const FT_STORAGE_KEY = 'oq_ft';
export const FT_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export const FT_PARAM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'gclid',
] as const;

export type FtParamKey = (typeof FT_PARAM_KEYS)[number];

export interface FirstTouch {
  v: 1;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  gclid?: string;
  landing_path?: string;
  referrer?: string;
  /** ISO-8601 time the touch was observed. */
  ts: string;
}

const VALUE_MAX = 200;
/** Click IDs are opaque and only useful whole; Meta's fbclid can exceed 200 chars. */
const CLICK_ID_MAX = 1000;
const CLICK_ID_KEYS: ReadonlySet<string> = new Set(['fbclid', 'gclid']);

function maxFor(key: string): number {
  return CLICK_ID_KEYS.has(key) ? CLICK_ID_MAX : VALUE_MAX;
}
const PATH_MAX = 200;

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4,}|[0-9a-f]{16,})$/i;

/** Replace record-id path segments (UUID, long numeric or hex ids, e.g. /contractor/bid/<claimId>) with ':id' so no record id is stored as a landing path. */
export function normalizeLandingPath(path: string): string {
  return path.split('/').map((seg) => (ID_SEGMENT.test(seg) ? ':id' : seg)).join('/');
}
/** Stay well below the 4096-byte per-cookie browser limit. */
const COOKIE_VALUE_MAX = 3000;

/** Printable ASCII only, trimmed, capped. Empty -> undefined. */
export function cleanValue(raw: unknown, max: number = VALUE_MAX): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.replace(/[^\x20-\x7E]/g, '').trim().slice(0, max);
  return v ? v : undefined;
}

export function hasTrackedKey(ft: Partial<FirstTouch> | null | undefined): boolean {
  if (!ft) return false;
  return FT_PARAM_KEYS.some((k) => typeof ft[k] === 'string' && (ft[k] as string).length > 0);
}

function referrerHost(referrer: string | null | undefined): string | undefined {
  if (!referrer) return undefined;
  try {
    return cleanValue(new URL(referrer).hostname.toLowerCase(), 120);
  } catch {
    return undefined;
  }
}

/**
 * Build a FirstTouch from a landing URL (null only when the URL is unparseable
 * or the page yields no landing path). The result may be untagged (no tracked
 * key): see hasTrackedKey(). `now` is injectable for tests.
 */
export function parseFirstTouch(
  url: URL | string,
  referrer: string | null | undefined,
  now: Date = new Date(),
): FirstTouch | null {
  let u: URL;
  try {
    u = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return null;
  }
  const ft: FirstTouch = { v: 1, ts: now.toISOString() };
  for (const key of FT_PARAM_KEYS) {
    const val = cleanValue(u.searchParams.get(key), maxFor(key));
    if (val) ft[key] = val;
  }
  const rawPath = cleanValue(u.pathname, PATH_MAX);
  const path = rawPath ? normalizeLandingPath(rawPath) : undefined;
  if (path) ft.landing_path = path;
  if (!hasTrackedKey(ft) && !path) return null;
  const ref = referrerHost(referrer);
  if (ref) ft.referrer = ref;
  return ft;
}

/** Validate an untrusted stored value (cookie / localStorage). */
export function deserializeFirstTouch(raw: string | null | undefined): FirstTouch | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const src = parsed as Record<string, unknown>;
  const ts = cleanValue(src.ts, 40);
  if (!ts || Number.isNaN(Date.parse(ts))) return null;
  const ft: FirstTouch = { v: 1, ts };
  for (const key of FT_PARAM_KEYS) {
    const val = cleanValue(src[key], maxFor(key));
    if (val) ft[key] = val;
  }
  const rawPath = cleanValue(src.landing_path, PATH_MAX);
  const path = rawPath ? normalizeLandingPath(rawPath) : undefined;
  if (path) ft.landing_path = path;
  // A valid record carries a tracked key (tagged) or a landing path (organic).
  if (!hasTrackedKey(ft) && !path) return null;
  const ref = cleanValue(src.referrer, 120);
  if (ref) ft.referrer = ref;
  return ft;
}

export function serializeFirstTouch(ft: FirstTouch): string {
  return JSON.stringify(ft);
}

/** `Domain=.otterquote.com` on otterquote.com and its subdomains; host-only elsewhere. */
export function cookieDomainAttr(hostname: string): string {
  const h = (hostname || '').toLowerCase();
  if (h === 'otterquote.com' || h.endsWith('.otterquote.com')) return '; Domain=.otterquote.com';
  return '';
}

/** Full Set-Cookie / document.cookie string, or null if it would be oversized. */
export function buildFirstTouchCookie(ft: FirstTouch, hostname: string, secure: boolean): string | null {
  const value = encodeURIComponent(serializeFirstTouch(ft));
  if (value.length > COOKIE_VALUE_MAX) return null;
  return (
    `${FT_COOKIE}=${value}; Path=/; Max-Age=${FT_MAX_AGE_SECONDS}; SameSite=Lax` +
    cookieDomainAttr(hostname) +
    (secure ? '; Secure' : '')
  );
}

/** Read one cookie's decoded value out of a Cookie header / document.cookie string. */
export function readCookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Request headers the untagged-capture decision reads (all optional). */
export interface FirstTouchRequestHints {
  /** Accept header: an untagged touch needs a page navigation (text/html). */
  accept?: string | null;
  /** Sec-GPC header: "1" is a Global Privacy Control opt-out. */
  gpc?: string | null;
  /** Sec-Purpose / Purpose header: any prefetch/prerender is not a visit. */
  purpose?: string | null;
  /** User-Agent: crawlers and link-preview fetchers never mint a touch. */
  userAgent?: string | null;
}

const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|monitor|uptime|curl|wget|python-requests/i;

/** True when the request headers say the visitor opted out of ad sharing. */
export function adOptedOutFromHeaders(
  cookieHeader: string | null | undefined,
  gpc: string | null | undefined,
): boolean {
  return (gpc || '').trim() === '1' || readCookieValue(cookieHeader, 'oq_ad_optout') === '1';
}

/**
 * The server-side decision both edge runtimes make: given a request URL,
 * its Cookie and Referer headers, return the Set-Cookie string to add, or
 * null (a first touch is already stored, an untagged request that is not an
 * eligible page navigation, or oversized). A stored touch is never replaced.
 *
 * An UNTAGGED touch (gh-3002) is recorded only for a real page navigation
 * (Accept names text/html, not a prefetch, not a crawler) by a visitor with no
 * Sec-GPC: 1 and no oq_ad_optout=1 cookie. Tagged touches are unaffected
 * (same as gh-1983).
 */
export function firstTouchSetCookie(
  requestUrl: string,
  cookieHeader: string | null | undefined,
  referer: string | null | undefined,
  now: Date = new Date(),
  hints: FirstTouchRequestHints = {},
): string | null {
  if (deserializeFirstTouch(readCookieValue(cookieHeader, FT_COOKIE))) return null;
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return null;
  }
  const ft = parseFirstTouch(u, referer, now);
  if (!ft) return null;
  if (!hasTrackedKey(ft)) {
    if (!/text\/html/i.test(hints.accept || '')) return null;
    if (/prefetch|prerender/i.test(hints.purpose || '')) return null;
    if (BOT_UA.test(hints.userAgent || '')) return null;
    if (adOptedOutFromHeaders(cookieHeader, hints.gpc)) return null;
  }
  return buildFirstTouchCookie(ft, u.hostname, u.protocol === 'https:');
}

/** Query-string key used to carry a first touch across a browser switch. */
export const FT_URL_PARAM = 'ft';

function toBase64Url(ascii: string): string {
  return btoa(ascii).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64u: string): string {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

/**
 * Encode a first touch for a URL (base64url JSON). Values are printable ASCII
 * by construction (cleanValue), so btoa is safe.
 */
export function encodeFirstTouchParam(ft: FirstTouch): string {
  return toBase64Url(serializeFirstTouch(ft));
}

/** Decode + validate an untrusted `ft` query value; null on anything malformed. */
export function decodeFirstTouchParam(raw: string | null | undefined): FirstTouch | null {
  if (!raw || raw.length > 4000 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    return deserializeFirstTouch(fromBase64Url(raw));
  } catch {
    return null;
  }
}

/** Upper bound on the encoded `ft` value added to an OAuth redirectTo. */
export const FT_URL_PARAM_MAX = 1500;

/**
 * Append the stored first touch to an OAuth redirectTo URL. Google refuses
 * OAuth inside the Facebook/Instagram in-app WebView and the user finishes in
 * Safari/Chrome — a different cookie jar — so the redirect URL is the only
 * thing that reliably crosses. Returns the URL unchanged when there is no touch.
 */
export function withFirstTouchParam(redirectUrl: string, ft: FirstTouch | null): string {
  if (!ft) return redirectUrl;
  try {
    // Keep the Google authorize URL small — a rejected redirect would break
    // sign-up itself, which matters more than attribution. Shed the least
    // useful fields first; if still too long, send no ft at all.
    let encoded = encodeFirstTouchParam(ft);
    if (encoded.length > FT_URL_PARAM_MAX) {
      const slim: FirstTouch = { ...ft };
      delete slim.landing_path;
      delete slim.referrer;
      delete slim.utm_term;
      delete slim.utm_content;
      encoded = encodeFirstTouchParam(slim);
      if (encoded.length > FT_URL_PARAM_MAX) return redirectUrl;
    }
    const u = new URL(redirectUrl);
    u.searchParams.set(FT_URL_PARAM, encoded);
    return u.toString();
  } catch {
    return redirectUrl;
  }
}
