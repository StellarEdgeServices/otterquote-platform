"use client";

import Script from "next/script";
import { useEffect, useState } from "react";

/**
 * GA4 host gate — gh-1619
 *
 * The production gtag was loading unconditionally on every host that served
 * this app (Vercel/branch previews, localhost) alongside production
 * (app.otterquote.com). A live GA4 read on 2026-09-04 (hostName dimension,
 * last 28 days, unfiltered) showed non-production hosts carrying 92%+ of the
 * entire property's session volume. Every conversion rate and funnel
 * denominator downstream of that property was wrong by roughly that factor.
 *
 * This component is the ONLY place the GA4 library may be requested from
 * this app — do not add a second `next/script` pointed at
 * googletagmanager.com/gtag/js anywhere else; a per-file variant of this
 * gate is how the bug recurs. It renders nothing (and requests nothing)
 * until a client-side hostname check passes, so the library never loads on
 * an unrecognised host.
 *
 * Fail-closed by design: an unrecognised hostname is far more likely to be a
 * new preview/staging surface than a new production domain, so it never
 * loads. Extending ALLOWED_HOSTS is a deliberate, reviewed decision.
 *
 * Every `gtag(...)` call site in this app already guards with
 * `typeof window.gtag === 'function'` (see app/types/gtag.d.ts, which
 * declares `gtag` as optional) — so leaving `window.gtag` undefined on
 * disallowed hosts is safe and requires no other changes.
 */
const ALLOWED_HOSTS = ["app.otterquote.com", "otterquote.com", "www.otterquote.com"];
const MEASUREMENT_ID = "G-D1Y1TLGEFY";
// gh-1939: Microsoft Clarity, same host allowlist as GA4 above -- one
// gate, not a second allowlist that can drift. Project id per
// js/ga-gate.js (the marketing-site gate for the same vendor).
const CLARITY_PROJECT_ID = "wwr7qlk8g5";

export function GA4Gate() {
  const [allowed, setAllowed] = useState(false);
  const [clarityAllowed, setClarityAllowed] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && ALLOWED_HOSTS.includes(window.location.hostname)) {
      setAllowed(true);

      // gh-1931/gh-1939: Clarity must never see a live Supabase
      // credential in the URL fragment. Ported from js/ga-gate.js's
      // fragment check (PR #1947) -- access_token, refresh_token and
      // provider_token are Supabase's own implicit-flow parameter
      // names and never appear outside the fragment, so a raw
      // substring check on window.location.hash carries no
      // collateral risk (a URL fragment is never a marketing/
      // referral parameter). This app calls detectSessionInUrl, so
      // it can receive this fragment on the same surface as the
      // marketing site -- this guard is load-bearing here too.
      // Only Clarity is suppressed; gtag behaviour is unchanged.
      const hash = window.location.hash;
      const hasAuthTokenInFragment =
        hash.indexOf("access_token") !== -1 ||
        hash.indexOf("refresh_token") !== -1 ||
        hash.indexOf("provider_token") !== -1;
      setClarityAllowed(!hasAuthTokenInFragment);
    }
  }, []);

  if (!allowed) return null;

  return (
    <>
      <Script
        async
        src={`https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Script id="ga4-init" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${MEASUREMENT_ID}');`}
      </Script>
      {clarityAllowed && (
        <Script id="clarity-init" strategy="afterInteractive">
          {`(function (c, l, a, r, i, t, y) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
    t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
    y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
})(window, document, 'clarity', 'script', '${CLARITY_PROJECT_ID}');`}
        </Script>
      )}
    </>
  );
}
