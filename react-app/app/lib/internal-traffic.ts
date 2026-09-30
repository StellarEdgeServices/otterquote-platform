/**
 * gh-2064: internal-traffic opt-out — React-app twin of js/internal-traffic.js
 * (the marketing-site static stack). Same contract:
 *
 *   Visiting any route with ?oq_internal=1 sets an in-memory internal flag
 *   for this page load AND writes an `oq_internal=1` cookie (1 year,
 *   Domain=.otterquote.com, Path=/) so a later navigation on this device —
 *   including one that does not carry the query param — is still
 *   recognised as internal. Once the cookie is set, isInternalTraffic()
 *   returns true on any route that carries it, param or not.
 *
 * GA4Gate.tsx and MetaPixelGate.tsx both call this before doing anything
 * else, exactly like js/ga-gate.js and js/meta-pixel-gate.js check
 * window.OQ_INTERNAL before loading anything.
 */

// BEGIN oq-synthetic-guard (gh-2356) -- TS twin of the block in js/ga-gate.js / js/meta-pixel-gate.js / js/internal-traffic.js
// (tests/gh2356-synthetic-traffic-guard.mjs compares the two lists literally).
export const OQ_SYNTHETIC_VALUE_PATTERNS: RegExp[] = [/^TEST(FBCLID|GCLID)/i, /^(?:(?:ceo|cto|cro|sloane|marty|ben|kevin|rwf?|autodrive)[-_]?(?:\d|walk|probe|test|stub)|k\d+[-_]?(?:walk|probe|test|stub))/i];
export const OQ_SYNTHETIC_PARAM_KEYS: string[] = ['fbclid', 'gclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
/** True for a QA walk: qa=1, or an fbclid/gclid/utm_* value that matches a synthetic pattern. Never throws. */
export function isSyntheticTrafficParams(params: URLSearchParams | null | undefined): boolean {
  try {
    if (!params) return false;
    if (params.get('qa') === '1') return true;
    for (const key of OQ_SYNTHETIC_PARAM_KEYS) {
      const v = params.get(key);
      if (!v) continue;
      if (OQ_SYNTHETIC_VALUE_PATTERNS.some((re) => re.test(v))) return true;
    }
  } catch {
    /* never break a page over detection */
  }
  return false;
}
// END oq-synthetic-guard

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function readCookie(name: string): string | null {
  if (!isBrowser() || !document.cookie) return null;
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function writeCookie(name: string, value: string): void {
  if (!isBrowser()) return;
  const oneYearSec = 60 * 60 * 24 * 365;
  const host = window.location.hostname;
  // Same reasoning as js/internal-traffic.js: a `.otterquote.com` cookie
  // domain is rejected outright on any other host (localhost, a Vercel
  // preview, a Playwright fixture server), so only apply it on an actual
  // otterquote.com host.
  const domainAttr = /(^|\.)otterquote\.com$/.test(host) ? '; domain=.otterquote.com' : '';
  document.cookie =
    `${name}=${encodeURIComponent(value)}; max-age=${oneYearSec}; path=/${domainAttr}; SameSite=Lax`;
}

/**
 * Returns true when this visit is our own internal walk/probe traffic
 * (?oq_internal=1 in the URL, or the oq_internal cookie already set from an
 * earlier page in the same walk). Also sets window.OQ_INTERNAL for parity
 * with the static stack, and writes the cookie the first time the query
 * param is seen.
 */
export function isInternalTraffic(): boolean {
  if (!isBrowser()) return false;

  let queryFlag = false;
  let syntheticFlag = false;
  try {
    const search = new URLSearchParams(window.location.search);
    queryFlag = search.get('oq_internal') === '1';
    syntheticFlag = isSyntheticTrafficParams(search);
  } catch {
    queryFlag = false;
    syntheticFlag = false;
  }
  const cookieFlag = readCookie('oq_internal') === '1';

  // gh-2356: a QA walk (qa=1 / test fbclid or utm) is persisted with the SAME cookie oq_internal uses (#2064), so later pages
  // that no longer carry the param are still recognised.
  if ((queryFlag || syntheticFlag) && !cookieFlag) {
    writeCookie('oq_internal', '1');
  }

  const internal = queryFlag || cookieFlag || syntheticFlag;
  (window as unknown as { OQ_INTERNAL?: boolean }).OQ_INTERNAL = internal;

  // gh-2068 review follow-up (cto36 REVIEW: FAIL, comment 5779410643,
  // recommended follow-up (a)): ?oq_internal=1 is a public, guessable,
  // shareable URL parameter -- a real homeowner who opens a forwarded walk
  // link gets this 1-year cookie too. Stripping the param from the address
  // bar right after reading it (history.replaceState, no navigation, no
  // reload) means a link this visitor then copies/shares/bookmarks FROM
  // this page no longer carries it onward. It does not undo the cookie
  // already set on THIS visit -- deciding whether is_synthetic should
  // require a trusted signal instead of the literal param, and whether to
  // ever un-set an already-written cookie, are separate follow-ups the
  // review left open (b)/(c), not done here.
  if (queryFlag) {
    try {
      const params = new URLSearchParams(window.location.search);
      params.delete('oq_internal');
      const qs = params.toString();
      const newUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
      window.history.replaceState(null, '', newUrl);
    } catch {
      // Never worth breaking the page for -- the cookie/flag above are
      // already set regardless of whether this cleanup succeeds.
    }
  }

  return internal;
}
