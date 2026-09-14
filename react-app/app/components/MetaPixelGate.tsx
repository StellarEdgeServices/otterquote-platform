"use client";

import Script from "next/script";
import { useEffect, useState } from "react";

/**
 * Meta Pixel host gate — gh-1817
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
 * nothing (and requests nothing) until a client-side hostname check
 * passes, so the library never loads on an unrecognised host.
 *
 * gh-1817 item 4 — LIVE (ceo42/gh1817-meta-pixel-live, supersedes #1839,
 * D-322/D-323): the placeholder empty-string PIXEL_ID below has been
 * replaced with the real Meta Pixel ID now that Dustin has a Business
 * Manager + ad account. The host allowlist below is what actually gates
 * firing on production vs. staging/preview/localhost -- see useEffect.
 *
 * Fail-closed by design, same as GA4Gate: an unrecognised hostname is far
 * more likely to be a new preview/staging surface than a new production
 * domain, so it never loads. Extending ALLOWED_HOSTS is a deliberate,
 * reviewed decision.
 *
 * Every `fbq(...)` call site in this app must guard with
 * `typeof window.fbq === 'function'` (fbq is only ever defined once a real
 * PIXEL_ID is configured and the host check passes) -- see get-started's
 * fireSignupAnalytics for the pattern.
 */
const ALLOWED_HOSTS = ["app.otterquote.com", "otterquote.com", "www.otterquote.com"];
const PIXEL_ID = "800470107451795";

export function MetaPixelGate() {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!PIXEL_ID) return; // dark merge: complete no-op until a real ID exists
    if (typeof window !== "undefined" && ALLOWED_HOSTS.includes(window.location.hostname)) {
      setAllowed(true);
    }
  }, []);

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
