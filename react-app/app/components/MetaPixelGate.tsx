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
 * Dark-merge / placeholder-ID no-op (gh-1817, item 4): PIXEL_ID below is an
 * empty placeholder until Dustin has a Meta Business Manager + ad account
 * and drops in the real value. With PIXEL_ID empty this component bails
 * out before the host check even runs, so it renders nothing and requests
 * nothing in ANY environment, production included, regardless of hostname.
 * This is intentional: the code path is complete and reviewable now, but
 * cannot fire anything until a real ID is configured. Do not treat an
 * empty PIXEL_ID as a bug.
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
// gh-1817 item 4: placeholder until Dustin supplies the real Meta Pixel ID
// (Business Manager + ad account creation is his action, not code). Keep
// this empty in every commit until that config drop -- see file header.
const PIXEL_ID = "";

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
