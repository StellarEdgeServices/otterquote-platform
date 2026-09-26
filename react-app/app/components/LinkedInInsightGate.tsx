"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { isInternalTraffic } from "../lib/internal-traffic";

/**
 * LinkedIn Insight Tag host + route gate — gh-1926
 *
 * Mirrors MetaPixelGate.tsx (gh-1817) exactly, for the same reason that
 * component mirrors GA4Gate.tsx (gh-1619): this app's production GA4 tag
 * used to load unconditionally on every host that served it (Vercel/branch
 * previews, localhost) alongside production (app.otterquote.com), and a
 * live read showed non-production hosts carrying the overwhelming
 * majority of the property's volume. A third, independent tracking tag
 * (LinkedIn Insight Tag) must not reintroduce that failure. See gh-1619
 * for the full incident writeup.
 *
 * This component is the ONLY place the LinkedIn Insight Tag library
 * (insight.min.js) may be requested from this app — do not add a second
 * `next/script` pointed at snap.licdn.com anywhere else; a per-file
 * variant of this gate is how the gh-1619 bug recurs. It renders nothing
 * (and requests nothing) until a client-side hostname AND pathname check
 * both pass, so the library never loads on an unrecognised host or on an
 * authenticated route.
 *
 * gh-1926: SHIPPED DARK. LINKEDIN_PARTNER_ID and LINKEDIN_CONVERSION_ID
 * below are empty-string placeholders -- no LinkedIn Campaign Manager
 * account/ad account exists yet. This is a complete no-op until a
 * follow-up config drop lands both real IDs the same way the Meta Pixel
 * ID was confirmed directly against Dustin's own screen. Do not invent a
 * real ID here.
 *
 * Fail-closed by design, same as GA4Gate/MetaPixelGate: an unrecognised
 * hostname OR an unrecognised route is far more likely to be a new
 * preview/staging surface or an authenticated page than a new public
 * marketing route, so it never loads. Extending ALLOWED_HOSTS or
 * ALLOWED_PATHS is a deliberate, reviewed decision.
 *
 * Every `lintrk(...)` call site in this app must guard with
 * `typeof window.lintrk === 'function'` (lintrk is only ever defined once
 * this gate has mounted) -- see get-started's fireSignupAnalytics for the
 * equivalent fbq pattern; use window.oqLinkedInTrackLead() (defined below,
 * mirroring js/linkedin-insight-gate.js's helper of the same name) for the
 * Lead conversion instead of a raw lintrk('track', ...) call, so the
 * LINKEDIN_CONVERSION_ID placeholder stays in exactly one place.
 */
const ALLOWED_HOSTS = ["app.otterquote.com", "otterquote.com", "www.otterquote.com"];
const LINKEDIN_PARTNER_ID = "";
// LinkedIn's conversion tracking API requires a Conversion ID that is
// distinct from the Partner ID (unlike Meta, which reuses one PIXEL_ID for
// both PageView and Lead) -- left as its own empty placeholder, do not
// reuse LINKEDIN_PARTNER_ID's value here.
const LINKEDIN_CONVERSION_ID = "";

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
    lintrk?: {
      (...args: unknown[]): void;
      callMethod?: (...args: unknown[]) => void;
      queue: unknown[][];
    };
    _linkedin_data_partner_ids?: string[];
    oqLinkedInTrackLead?: () => void;
  }
}

export function LinkedInInsightGate() {
  const pathname = usePathname();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    // gh-1926 (gh-2064 pattern): internal-traffic opt-out, checked first --
    // our own walks/probes must never load the LinkedIn Insight Tag,
    // regardless of host or path allowlist below.
    if (isInternalTraffic()) return;
    if (!LINKEDIN_PARTNER_ID) return; // dark merge: complete no-op until a real ID exists
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
        src="https://snap.licdn.com/li.lms-analytics/insight.min.js"
        strategy="afterInteractive"
      />
      {/*
        lintrk base-code stub, LinkedIn's own callMethod-forwarding shape
        (same reasoning as MetaPixelGate.tsx's gh-2000 fix for fbq):
        insight.min.js mutates this SAME lintrk object in place once it
        loads and drains whatever was queued at that point -- it does not
        reassign window.lintrk. A plain queue-push stub would keep the
        initial push "working" while silently dropping any Lead call fired
        after load.
      */}
      <Script id="linkedin-insight-init" strategy="afterInteractive">
        {`window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
window._linkedin_data_partner_ids.push('${LINKEDIN_PARTNER_ID}');
if (!window.lintrk) { var n = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; n.queue = []; window.lintrk = n; }
window.oqLinkedInTrackLead = function () {
  if (!'${LINKEDIN_CONVERSION_ID}') { return; }
  window.lintrk('track', { conversion_id: '${LINKEDIN_CONVERSION_ID}' });
};`}
      </Script>
    </>
  );
}
