"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { isInternalTraffic } from "../lib/internal-traffic";

/**
 * Reddit Pixel host + route gate — gh-1926
 *
 * Mirrors MetaPixelGate.tsx (gh-1817) exactly, for the same reason that
 * component mirrors GA4Gate.tsx (gh-1619): this app's production GA4 tag
 * used to load unconditionally on every host that served it (Vercel/branch
 * previews, localhost) alongside production (app.otterquote.com), and a
 * live read showed non-production hosts carrying the overwhelming
 * majority of the property's volume. A fourth, independent tracking tag
 * (Reddit Pixel) must not reintroduce that failure. See gh-1619 for the
 * full incident writeup.
 *
 * This component is the ONLY place the Reddit Pixel library (redpixel.js)
 * may be requested from this app — do not add a second `next/script`
 * pointed at www.redditstatic.com anywhere else; a per-file variant of
 * this gate is how the gh-1619 bug recurs. It renders nothing (and
 * requests nothing) until a client-side hostname AND pathname check both
 * pass, so the library never loads on an unrecognised host or on an
 * authenticated route.
 *
 * gh-1926: SHIPPED DARK. REDDIT_PIXEL_ID below is an empty-string
 * placeholder -- no Reddit Ads account exists yet. This is a complete
 * no-op until a follow-up config drop lands the real ID the same way the
 * Meta Pixel ID was confirmed directly against Dustin's own screen. Do
 * not invent a real ID here.
 *
 * Fail-closed by design, same as GA4Gate/MetaPixelGate: an unrecognised
 * hostname OR an unrecognised route is far more likely to be a new
 * preview/staging surface or an authenticated page than a new public
 * marketing route, so it never loads. Extending ALLOWED_HOSTS or
 * ALLOWED_PATHS is a deliberate, reviewed decision.
 *
 * Every `rdt(...)` call site in this app must guard with
 * `typeof window.rdt === 'function'` (rdt is only ever defined once this
 * gate has mounted) -- see get-started's fireSignupAnalytics for the
 * equivalent fbq pattern.
 */
const ALLOWED_HOSTS = ["app.otterquote.com", "otterquote.com", "www.otterquote.com"];
const REDDIT_PIXEL_ID = "";

// Same pre-auth marketing/conversion route as MetaPixelGate.tsx's
// ALLOWED_PATHS: `/get-started` is the homeowner sign-up funnel (Lead
// event fires here, see get-started/page.tsx) and is unauthenticated by
// design. See MetaPixelGate.tsx's own comment for the full per-route
// audit this list is based on.
const ALLOWED_PATHS = ["/get-started"];

function isAllowedPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return ALLOWED_PATHS.some(p => pathname === p || pathname.startsWith(p + "/"));
}

declare global {
  interface Window {
    rdt?: {
      (...args: unknown[]): void;
      sendEvent?: (...args: unknown[]) => void;
      callQueue: unknown[][];
    };
  }
}

export function RedditPixelGate() {
  const pathname = usePathname();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    // gh-1926 (gh-2064 pattern): internal-traffic opt-out, checked first --
    // our own walks/probes must never load the Reddit Pixel, regardless of
    // host or path allowlist below.
    if (isInternalTraffic()) return;
    if (!REDDIT_PIXEL_ID) return; // dark merge: complete no-op until a real ID exists
    if (!isAllowedPath(pathname)) return; // authenticated/non-marketing route -- never load
    if (typeof window !== "undefined" && ALLOWED_HOSTS.includes(window.location.hostname)) {
      setAllowed(true);
    }
  }, [pathname]);

  if (!allowed) return null;

  return (
    <>
      <Script
        async
        src="https://www.redditstatic.com/ads/redpixel.js"
        strategy="afterInteractive"
      />
      {/*
        rdt base-code stub, Reddit's own sendEvent-forwarding shape (same
        reasoning as MetaPixelGate.tsx's gh-2000 fix for fbq): redpixel.js
        mutates this SAME rdt object in place once it loads and drains
        whatever was queued at that point -- it does not reassign
        window.rdt. A plain queue-push stub would keep the initial push
        "working" while silently dropping any Lead call fired after load.
      */}
      <Script id="reddit-pixel-init" strategy="afterInteractive">
        {`if (!window.rdt) { var n = function () { n.sendEvent ? n.sendEvent.apply(n, arguments) : n.callQueue.push(arguments); }; n.callQueue = []; window.rdt = n; }
window.rdt('init', '${REDDIT_PIXEL_ID}');
window.rdt('track', 'PageVisit');`}
      </Script>
    </>
  );
}
