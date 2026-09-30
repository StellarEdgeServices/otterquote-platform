import { hasAdOptOutCookie } from './ad-optout';

/**
 * [gh-2107 / D-330 half 2] Global Privacy Control, read from the browser.
 *
 * Dustin's ruling "b." (#2078 comment 5801822166), scope item 2: the client reads navigator.globalPrivacyControl and the
 * server honours Sec-GPC. A visitor whose browser sends GPC has opted out of advertising sharing; create-payment-intent
 * records that on the buyer's profile so the server-side Meta CAPI Purchase is skipped.
 *
 * Returns `{ gpc: true }` ONLY when the browser reports GPC as exactly true, otherwise `{}`, so a request from any other
 * visitor is unchanged. Never throws (a locked-down or exotic navigator must not break checkout).
 */
export function gpcField(): { gpc?: true } {
  try {
    const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as (Navigator & { globalPrivacyControl?: unknown }) | undefined;
    if (nav && nav.globalPrivacyControl === true) return { gpc: true };
    // gh-1925 item 2: the privacy s12 button leaves the same oq_ad_optout=1 cookie GPC leaves; report it like GPC (exact match only).
    return hasAdOptOutCookie() ? { gpc: true } : {};
  } catch {
    return {};
  }
}
