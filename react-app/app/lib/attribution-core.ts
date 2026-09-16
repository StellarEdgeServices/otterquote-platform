/**
 * gh-1983 — first-touch ad attribution, pure core (no DOM, no imports).
 *
 * Shared by three runtimes, so it must stay dependency-free:
 *   - the React app (react-app/app/lib/attribution.ts, via `@/lib/...`)
 *   - Next.js middleware on app.otterquote.com (react-app/middleware.ts)
 *   - the Netlify edge function on otterquote.com
 *     (netlify/edge-functions/first-touch-attribution.ts, relative `.ts` import)
 *
 * Semantics: FIRST TAGGED TOUCH. A touch is recorded only when the landing URL
 * carries at least one tracked key (utm_source/medium/campaign/content/term,
 * fbclid, gclid). An untagged visit never creates or overwrites the record, and
 * an existing record is never replaced by a later touch (callers check first).
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
/** Stay well below the 4096-byte per-cookie browser limit. */
const COOKIE_VALUE_MAX = 3000;

/** Printable ASCII only, trimmed, capped. Empty -> undefined. */
export function cleanValue(raw: unknown, max: number = VALUE_MAX): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.replace(/[^\x20-\x7E]/g, '').trim().slice(0, max);
  return v ? v : undefined;
}

function hasTrackedKey(ft: Partial<FirstTouch> | null | undefined): boolean {
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
 * Build a FirstTouch from a landing URL, or null when the URL carries no
 * tracked key. `now` is injectable for tests.
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
  if (!hasTrackedKey(ft)) return null;
  const path = cleanValue(u.pathname, PATH_MAX);
  if (path) ft.landing_path = path;
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
  if (!hasTrackedKey(ft)) return null;
  const path = cleanValue(src.landing_path, PATH_MAX);
  if (path) ft.landing_path = path;
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

/**
 * The server-side decision both edge runtimes make: given a request URL,
 * its Cookie and Referer headers, return the Set-Cookie string to add, or
 * null (no tracked key, a valid first touch already stored, or oversized).
 */
export function firstTouchSetCookie(
  requestUrl: string,
  cookieHeader: string | null | undefined,
  referer: string | null | undefined,
  now: Date = new Date(),
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
  return buildFirstTouchCookie(ft, u.hostname, u.protocol === 'https:');
}
