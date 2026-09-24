/**
 * [gh-2107 / D-330] The advertising-sharing opt-out, as the BROWSER sees it (privacy policy Section 12).
 *
 * Ben's ruling on #2078 (5805593465, item a): "The browser pixel honors the opt-out too. For GPC=1 or
 * ad_sharing_opt_out = true, the Meta pixel does not load. Section 12 promises an opt-out of *sharing*, not of one channel."
 * The server-side CAPI Purchase honours the same flag (stripe-webhook, PR #2107); this is the browser half.
 *
 * TWO INPUTS, one first-party cookie:
 *   - Global Privacy Control: `navigator.globalPrivacyControl === true`.
 *   - The stored flag (profiles.ad_sharing_opt_out = true), read for the signed-in visitor on the one authenticated route the
 *     pixel is allowed on (MetaPixelGate reads it there before it loads anything).
 * When either is seen, an `oq_ad_optout=1` cookie (1 year, Domain=.otterquote.com, the same shape as `oq_internal`) is written so
 * that every later page on either stack, static or React, on this device is opted out before it has to ask again.
 * js/meta-pixel-gate.js reads and writes the same cookie.
 *
 * FAIL-CLOSED WHERE THE ANSWER IS UNKNOWN AND KNOWABLE: on the authenticated route, a profile read that fails means the pixel
 * does not load. Everywhere else the only inputs are GPC and the cookie, which are synchronous and cannot be "unknown".
 * Every function here is total and never throws.
 */

export const AD_OPTOUT_COOKIE = 'oq_ad_optout';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/** The browser's Global Privacy Control signal: only the boolean true opts out. */
export function gpcOptOut(): boolean {
  try {
    const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as (Navigator & { globalPrivacyControl?: unknown }) | undefined;
    return !!nav && nav.globalPrivacyControl === true;
  } catch {
    return false;
  }
}

export function hasAdOptOutCookie(): boolean {
  try {
    if (!isBrowser() || !document.cookie) return false;
    const m = document.cookie.match(new RegExp('(?:^|; )' + AD_OPTOUT_COOKIE + '=([^;]*)'));
    return !!m && decodeURIComponent(m[1]) === '1';
  } catch {
    return false;
  }
}

export function recordAdOptOutCookie(): void {
  try {
    if (!isBrowser()) return;
    const oneYearSec = 60 * 60 * 24 * 365;
    // Same reasoning as internal-traffic.ts: a `.otterquote.com` cookie domain is rejected on any other host, so only apply it there.
    const domainAttr = /(^|\.)otterquote\.com$/.test(window.location.hostname) ? '; domain=.otterquote.com' : '';
    document.cookie = `${AD_OPTOUT_COOKIE}=1; max-age=${oneYearSec}; path=/${domainAttr}; SameSite=Lax`;
  } catch {
    /* never break the page over a cookie */
  }
}

/** Synchronous opt-out: GPC or the cookie. Writes the cookie when GPC is seen, so later pages and the static stack see it too. */
export function isAdSharingOptedOut(): boolean {
  if (gpcOptOut()) {
    if (!hasAdOptOutCookie()) recordAdOptOutCookie();
    return true;
  }
  return hasAdOptOutCookie();
}

export interface ProfileReader {
  auth: { getSession(): PromiseLike<{ data: { session: { user: { id: string } } | null }; error?: unknown }> };
  from(table: string): {
    select(cols: string): { eq(col: string, val: string): { maybeSingle(): PromiseLike<{ data: { ad_sharing_opt_out?: boolean | null } | null; error: unknown }> } };
  };
}

/**
 * The signed-in visitor's stored flag:
 *   `true`          opted out (also leaves the cookie);
 *   `false`         not opted out (a session exists and its profile is not flagged, or has no row and no error);
 *   `'no_session'`  there is NO session: nothing is knowable about who this is;
 *   `'unknown'`     there IS a session but the flag could not be read (read error, thrown error, session error).
 * REVIEW: FAIL 5806828503 F1 on #2134: the gate must treat these differently. `no_session` on a marketing route loads the pixel as it
 * always did; `unknown` never loads it (an unknown opt-out is not shared); on the authenticated route neither loads it.
 */
export type StoredOptOut = boolean | 'no_session' | 'unknown';

export async function readStoredOptOut(sb: ProfileReader): Promise<StoredOptOut> {
  try {
    const { data, error } = await sb.auth.getSession();
    const id = data?.session?.user?.id;
    if (!id) return error ? 'unknown' : 'no_session';
    const res = await sb.from('profiles').select('ad_sharing_opt_out').eq('id', id).maybeSingle();
    if (res.error) return 'unknown';
    const optedOut = res.data?.ad_sharing_opt_out === true;
    if (optedOut) recordAdOptOutCookie();
    return optedOut;
  } catch {
    return 'unknown';
  }
}
