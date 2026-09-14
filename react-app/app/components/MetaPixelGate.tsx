"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

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
 */
const ALLOWED_HOSTS = ["app.otterquote.com", "otterquote.com", "www.otterquote.com"];
const PIXEL_ID = "800470107451795";

// REWORK: pre-auth marketing/conversion routes only. `/get-started` is the
// homeowner sign-up funnel (Lead event fires here, see get-started/page.tsx)
// and is unauthenticated by design. Every other top-level route under
// react-app/app was checked and excluded: `/` is an unauthenticated D-211
// scaffold placeholder, not marketing copy, so it is left out rather than
// assumed safe; `/login` is an unauthenticated auth-utility page (not
// marketing) so it is left out too; `/refer` requires a signed-in user
// (redirects to /login otherwise) so it is excluded as authenticated;
// `/(homeowner)/*`, `/admin`, `/contractor/*`, `/partner/*` all require
// auth; `/auth-callback` and `/trade-selector` are mid-flow/post-signup,
// not marketing. `/docs` and `/test` carry no page.tsx (not real routes).
const ALLOWED_PATHS = ["/get-started"];

function isAllowedPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return ALLOWED_PATHS.some(p => pathname === p || pathname.startsWith(p + "/"));
}

export function MetaPixelGate() {
  const pathname = usePathname();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!PIXEL_ID) return; // dark merge: complete no-op until a real ID exists
    if (!isAllowedPath(pathname)) return; // REWORK: authenticated/non-marketing route -- never load
    if (typeof window !== "undefined" && ALLOWED_HOSTS.includes(window.location.hostname)) {
      setAllowed(true);
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
      <Script id="meta-pixel-init" strategy="afterInteractive">
        {`window.fbq = window.fbq || function () { (window.fbq.queue = window.fbq.queue || []).push(arguments); };
fbq('init', '${PIXEL_ID}');
fbq('track', 'PageView');`}
      </Script>
    </>
  );
}
