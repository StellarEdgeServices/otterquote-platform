/**
 * Single GA4 emit call site — gh-1940.
 *
 * Every `gtag('event', ...)` call this app makes for a funnel-measurement
 * event should go through this function, so tracking cannot fragment back
 * into one-off `window.gtag(...)` calls scattered per-file (the exact state
 * this issue found: two events, two different files, no shared helper).
 *
 * Safe by construction:
 *   - Never throws — every failure mode (gtag absent, window absent, a
 *     malformed param) is swallowed. Analytics must never break a user
 *     action.
 *   - Never blocks — it is a synchronous, fire-and-forget call.
 *   - Never queues — if `window.gtag` is not present right now (GA4Gate's
 *     production-hostname check hasn't passed yet, an ad blocker removed
 *     it, or this is SSR/no window at all) the event is dropped, not
 *     buffered. GA4Gate is fail-closed by design (see its own header
 *     comment); a queue here would fight that design and could grow
 *     unboundedly on a host where gtag never loads.
 *   - Never loads gtag itself. This module only reads `window.gtag` —
 *     GA4Gate.tsx remains the only place the GA4 library is requested.
 *
 * ROOT CAUSE NOTE (gh-1940 recon): `sign_up` and `homeowner_signup` already
 * existed in app/get-started/page.tsx before this helper and had a real
 * GA4 count of 0 over 10 days (property 541423859) despite 2 real signups
 * in the same window (Supabase auth.users). Both call sites fired the
 * event and then, in the same synchronous block, navigated the page away —
 * the Google path via `signInWithOAuth` (browser leaves for
 * accounts.google.com) and the password auto-confirm path via
 * `window.location.href = ...`. gtag.js's default transport does not
 * guarantee a hit is flushed before an immediate same-tick navigation
 * cancels the in-flight request; GA4's documented fix is
 * `transport_type: 'beacon'`, which was absent from the original calls.
 * That is almost certainly why the existing emit never fired — nothing
 * about the GA4Gate host check or script load was broken (page_view and
 * a dozen other events land fine on the same property/window). Every
 * event this helper sends immediately before a navigation must pass
 * `beacon: true` so the same bug cannot recur silently.
 */

'use client';

type TrackParams = Record<string, string | number | boolean | null | undefined>;

interface TrackOptions {
  /**
   * Set true for any event fired immediately before a navigation
   * (redirect, OAuth handoff, `window.location.href` assignment) — see the
   * ROOT CAUSE NOTE above. Routes the hit through `navigator.sendBeacon`
   * (GA4's `transport_type: 'beacon'`) instead of gtag's default transport,
   * which is not guaranteed to survive a same-tick page unload.
   */
  beacon?: boolean;
}

/** Minimal ambient shape — the real declaration lives in app/types/gtag.d.ts. */
function getGtag(): ((...args: unknown[]) => void) | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { gtag?: (...args: unknown[]) => void };
  return typeof w.gtag === 'function' ? w.gtag : undefined;
}

export function track(name: string, params: TrackParams = {}, options: TrackOptions = {}): void {
  try {
    const gtag = getGtag();
    if (!gtag) return; // GA4Gate has not loaded (blocked host, ad blocker, SSR) — no-op, no queue.

    const payload: Record<string, unknown> = { ...params };
    if (options.beacon) {
      payload.transport_type = 'beacon';
    }
    gtag('event', name, payload);
  } catch {
    // Never throw — an analytics failure must never break a user-facing action.
  }
}
