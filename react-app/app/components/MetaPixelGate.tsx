"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { isInternalTraffic } from "../lib/internal-traffic";
import { isAdSharingOptedOut, readStoredOptOut, type ProfileReader } from "../lib/ad-optout";

/**
 * Meta Pixel host + route gate — gh-1817
 *
 * Mirrors GA4Gate.tsx (gh-1619) exactly, for the same reason that fix
 * exists: this app's production GA4 tag used to load unconditionally on
 * every host that served it (Vercel/branch previews, localhost) alongside
 * production (app.otterquote.com), and a live read showed non-production
 * hosts carrying the overwhelming majority of the property's volume. A
 * second, independent tracking tag (Meta Pixel) must not reintroduce that
 * failure. See gh-1619 for the full incident writeup.
 *
 * This component is the ONLY place the Meta Pixel library (fbevents.js)
 * may be requested from this app — do not add a second `next/script`
 * pointed at connect.facebook.net/en_US/fbevents.js anywhere else; a
 * per-file variant of this gate is how the gh-1619 bug recurs. It renders
 * nothing (and requests nothing) until a client-side hostname AND pathname
 * check both pass, so the library never loads on an unrecognised host or
 * on an authenticated route.
 *
 * gh-1817 item 4 -- LIVE (ceo42/gh1817-meta-pixel-live, supersedes #1839,
 * D-322/D-323): the placeholder empty-string PIXEL_ID below has been
 * replaced with the real Meta Pixel ID now that Dustin has a Business
 * Manager + ad account. The host allowlist below is what actually gates
 * firing on production vs. staging/preview/localhost -- see useEffect.
 *
 * REWORK (LEGAL-READ FAIL on PR #1928, D-322 "never on authenticated
 * surfaces"): the root mount in layout.tsx means every route under this
 * app -- including every authenticated surface (/contractor/*, the
 * (homeowner) route group, /admin, /partner/*) -- was rendering this
 * component, so PageView fired there too. Fixed with a pathname allowlist:
 * ALLOWED_PATHS names the exact pre-auth marketing/conversion routes this
 * app currently has; every route this app actually serves under
 * react-app/app was enumerated and checked for an auth requirement before
 * this list was written (see the PR's REWORK evidence for the per-route
 * finding). Everything not explicitly listed is denied by default --
 * adding a route here is a deliberate, reviewed decision, same posture as
 * ALLOWED_HOSTS below.
 *
 * Fail-closed by design, same as GA4Gate: an unrecognised hostname OR an
 * unrecognised route is far more likely to be a new preview/staging
 * surface or an authenticated page than a new public marketing route, so
 * it never loads. Extending ALLOWED_HOSTS or ALLOWED_PATHS is a
 * deliberate, reviewed decision.
 *
 * Every `fbq(...)` call site in this app must guard with
 * `typeof window.fbq === 'function'` (fbq is only ever defined once a real
 * PIXEL_ID is configured and the host+path check passes) -- see
 * get-started's fireSignupAnalytics for the pattern.
 *
 * gh-2107 / D-330 (Ben's ruling on #2078, 5805593465, item a; privacy policy Section 12 promises an opt-out of SHARING, not
 * of one channel): the pixel does not load for a visitor who has opted out of advertising sharing. Two inputs, see
 * lib/ad-optout.ts: the browser's Global Privacy Control signal (or the `oq_ad_optout` cookie it and the stored flag leave),
 * checked synchronously for every route, and the signed-in visitor's stored flag (profiles.ad_sharing_opt_out), read BEFORE
 * anything loads on EVERY allowed route whenever a session exists (REVIEW: FAIL 5806828503 F1 on #2134: an opt-out recorded
 * by GPC in another browser, or by an admin from a support email, must follow the known person to /get-started too).
 * A session whose flag cannot be read never loads the pixel (an unknown opt-out is not shared). With NO session nothing is
 * knowable and a marketing route loads as before; the authenticated route requires a definite `false`.
 * js/meta-pixel-gate.js applies the same rule.
 *
 * D-330 (amends D-322 for exactly one path, 2026-09-22, gh-2078 comment
 * 5780257974; Dustin's ruling comment 5777193662 "Yes to both."): the
 * measurement-checkout success path (`/help-measurements`, the $15 Hover
 * purchase -- see that page's handlePaid and its gh-951 resume effect) is
 * added to ALLOWED_PATHS below despite being an authenticated route, so
 * `fbqTrack('Purchase', ...)` (lib/track.ts) is a real event instead of the
 * no-op it was under D-322's authenticated-surface-only scoping. This is a
 * narrow, reviewed widening of ONE route, not a change to the
 * fail-closed-by-default posture: every other authenticated route stays
 * excluded exactly as before (proved by
 * __tests__/meta-pixel-gate-allowed-paths.test.ts, which enumerates every
 * real page.tsx route in this app). D-322's own reasoning -- no session replay / no PageView noise on authenticated surfaces --
 * holds for `/help-measurements`, and gh-2107 (Ben's DECIDED ruling d. on #2078, 5805593465, closing two gaps #2106 left) makes
 * that true in code: on that route the pixel is INITIALISED (so `fbqTrack('Purchase', ...)` is a real event) but NO `PageView` is
 * sent, because D-330 allows only Purchase there (the earlier "accepted PageView" paragraph is superseded). And a live Supabase
 * credential in the URL FRAGMENT (access_token / refresh_token / provider_token) means the pixel never loads, on any route,
 * exactly as js/meta-pixel-gate.js does: fbevents.js derives its `dl` parameter from location.href, so the only way to keep a
 * token pair out of facebook.com/tr is never to load it while the fragment carries one (gh-1969; this gate lacked that check).
 */
const ALLOWED_HOSTS = ["app.otterquote.com", "otterquote.com", "www.otterquote.com"];
const PIXEL_ID = "800470107451795";

// REWORK: pre-auth marketing/conversion routes, PLUS the one D-330
// authenticated exception below. `/get-started` is the homeowner sign-up
// funnel (Lead event fires here, see get-started/page.tsx) and is
// unauthenticated by design. Every other top-level route under
// react-app/app was checked and excluded: `/` is an unauthenticated D-211
// scaffold placeholder, not marketing copy, so it is left out rather than
// assumed safe; `/login` is an unauthenticated auth-utility page (not
// marketing) so it is left out too; `/refer` requires a signed-in user
// (redirects to /login otherwise) so it is excluded as authenticated;
// `/(homeowner)/*`, `/admin`, `/contractor/*`, `/partner/*` all require
// auth; `/auth-callback` and `/trade-selector` are mid-flow/post-signup,
// not marketing. `/docs` and `/test` carry no page.tsx (not real routes).
//
// D-330 EXCEPTION (gh-2078): `/help-measurements` is authenticated (it
// lives under the `(homeowner)` route group, gated by HomeownerShell) and
// is added here ANYWAY, by explicit, reviewed decision -- see the class
// docstring above. This is the ONLY authenticated route on this list;
// every other authenticated route enumerated above remains excluded, which
// __tests__/meta-pixel-gate-allowed-paths.test.ts asserts by walking every
// real page.tsx this app serves.
const ALLOWED_PATHS = ["/get-started", "/help-measurements"];

export function isAllowedPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return ALLOWED_PATHS.some(p => pathname === p || pathname.startsWith(p + "/"));
}

export { ALLOWED_PATHS };

// gh-2107 / #2106 gap 1: the same predicate as js/meta-pixel-gate.js (gh-1969) -- a fragment substring check, not a path list
// ("a path list can never be complete"). fbevents.js reads location.href for its `dl` value, so the pixel never loads while a
// live Supabase implicit-flow credential is in the URL.
export function urlHasAuthToken(hash: string | null | undefined): boolean {
  const h = (hash ?? "").toLowerCase(); // case-insensitive (REVIEW N2 on #2139): a differently cased key is still a credential
  return h.indexOf("access_token") !== -1 || h.indexOf("refresh_token") !== -1 || h.indexOf("provider_token") !== -1;
}

// REVIEW B1 on #2139: a credential in the QUERY STRING reaches Meta the same way (the pixel's server config strips no keys), so the
// query is guarded too, by EXACT parameter name. Not by substring, and NOT `code`: `code` is this site's own referral parameter
// (`?code=`, ga-gate.js gh-1931), and promocode / zipcode / mytoken must keep loading. Kept in sync with js/meta-pixel-gate.js.
const AUTH_QUERY_KEYS = ["access_token", "refresh_token", "provider_token", "token_hash", "token"];

export function queryHasAuthToken(search: string | null | undefined): boolean {
  try {
    const params = new URLSearchParams(search ?? "");
    // case-INSENSITIVE on the key (`?Access_Token=` is still a credential), still exact: `code` / `mytoken` / `tokens` are not.
    return Array.from(params.keys()).some((k) => AUTH_QUERY_KEYS.includes(k.toLowerCase()));
  } catch {
    return true; // an unparseable query string: fail closed
  }
}

// REVIEW B3 on #2139 (5808373334): fbevents.js registers its OWN `pageshow` listener that sends a PageView when the page is restored
// from the back/forward cache (`event.persisted`), with no `disablePushState` check, so after a Purchase on /help-measurements a Back
// navigation would send a PageView where D-330 allows only Purchase. This listener is registered BEFORE any pixel script is rendered
// (listeners on `window` run in registration order), and stops a persisted pageshow only where PageView is not allowed. It looks at
// the path when the event fires, so a restore onto /get-started (D-322) is untouched. One stable handler: re-adding it is a no-op.
function stopPersistedPageshowOnPurchaseOnlyPaths(e: Event): void {
  if ((e as PageTransitionEvent).persisted && !pageViewAllowed(window.location.pathname)) e.stopImmediatePropagation();
}

export function installPersistedPageshowGuard(): void {
  if (typeof window === "undefined") return;
  window.removeEventListener("pageshow", stopPersistedPageshowOnPurchaseOnlyPaths);
  window.addEventListener("pageshow", stopPersistedPageshowOnPurchaseOnlyPaths);
}

// gh-2107 / #2106 gap 2: D-330 allows only `Purchase` on /help-measurements, so no PageView is sent there. Every other allowed
// route (/get-started, D-322) keeps its PageView.
const PURCHASE_ONLY_PATHS = ["/help-measurements"];

export function pageViewAllowed(pathname: string | null): boolean {
  if (!pathname) return false;
  return !PURCHASE_ONLY_PATHS.some(p => pathname === p || pathname.startsWith(p + "/"));
}

// gh-2107: the allowed routes that are authenticated, where the stored opt-out flag must be read before the pixel loads.
const AUTHENTICATED_PATHS = ["/help-measurements"];

export function isAuthenticatedPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return AUTHENTICATED_PATHS.some(p => pathname === p || pathname.startsWith(p + "/"));
}

export function MetaPixelGate() {
  const pathname = usePathname();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    // Every evaluation starts closed: `allowed` must not be sticky across client-side navigation (REVIEW N1 on #2134).
    setAllowed(false);
    // gh-2064: internal-traffic opt-out, checked first -- our own
    // walks/probes must never load the Meta Pixel, regardless of host or
    // path allowlist below.
    if (isInternalTraffic()) return;
    if (!PIXEL_ID) return; // dark merge: complete no-op until a real ID exists
    if (!isAllowedPath(pathname)) return; // REWORK: authenticated/non-marketing route -- never load
    // gh-2107: an opted-out visitor (GPC, or the cookie either signal leaves) never loads the pixel, on any route.
    if (isAdSharingOptedOut()) return;
    // gh-2107 / #2106 gap 1 + REVIEW B1: a live credential in the URL fragment OR query string: the pixel never loads (any route).
    if (typeof window !== "undefined" && (urlHasAuthToken(window.location.hash) || queryHasAuthToken(window.location.search))) return;
    if (typeof window !== "undefined" && ALLOWED_HOSTS.includes(window.location.hostname)) {
      // gh-2107 (REVIEW: FAIL 5806828503 F1): the stored flag is read BEFORE loading anything, on every allowed route, whenever a
      // session exists. Only a definite `false` loads the pixel; `no_session` loads it too, but only on a marketing route.
      let cancelled = false;
      // Loaded lazily so the marketing routes never pull the auth client in until this check runs.
      import("../lib/supabase")
        .then((m) => readStoredOptOut(m.supabase as unknown as ProfileReader))
        .catch(() => "unknown" as const)
        .then((stored) => {
          if (cancelled) return;
          if (stored === false || (stored === "no_session" && !isAuthenticatedPath(pathname))) {
            installPersistedPageshowGuard(); // before the pixel <Script>s render (REVIEW B3 on #2139)
            setAllowed(true);
          }
        });
      return () => { cancelled = true; };
    }
  }, [pathname]);

  if (!allowed) return null;

  return (
    <>
      <Script
        async
        src="https://connect.facebook.net/en_US/fbevents.js"
        strategy="afterInteractive"
      />
      {/*
        gh-2000: this must be Meta's standard base-code stub (checks for a
        `callMethod` fbevents.js installs on load and forwards to it), not
        a stub that only ever pushes onto a queue. fbevents.js mutates this
        SAME fbq object in place -- it does not reassign window.fbq -- and
        drains whatever was queued at load time exactly once. A plain
        queue-push stub kept init/PageView "working" (queued before
        fbevents.js loads, drained on load) while silently dropping every
        event fired afterward, including fbq('track','Lead') on submit,
        because nothing ever reads the queue again once fbevents.js has
        taken over via callMethod. See #2000 for the live proof.
      */}
      <Script id="meta-pixel-init" strategy="afterInteractive">
        {`if (!window.fbq) { var n = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; window.fbq = n; if (!window._fbq) { window._fbq = n; } n.push = n; n.loaded = true; n.version = '2.0'; n.queue = []; }
window.fbq.disablePushState = true;
fbq('init', '${PIXEL_ID}');${pageViewAllowed(pathname) ? "\nfbq('track', 'PageView');" : ""}`}
      </Script>
    </>
  );
}
