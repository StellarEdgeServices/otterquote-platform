"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
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

// gh-1939 REWORK (CTO RUN 31 REVIEW: FAIL D-2, Dustin ruling 2026-09-15):
// root-mounting a session-replay recorder with no pathname gate turns it on
// across every authenticated route (dashboard/admin/contractor/partner/
// homeowner-(homeowner) group) with no masking configured anywhere in the
// repo -- the same shape that failed a LEGAL-READ on PR #1928 for Meta
// Pixel (see MetaPixelGate.tsx:32-43). Dustin has ruled Clarity may ship
// path-scoped to unauthenticated funnel routes only, never on dashboard/
// admin/contractor/authenticated pages. Mirrors MetaPixelGate.tsx's
// ALLOWED_PATHS pattern exactly, including its route enumeration:
// `/get-started` is the homeowner sign-up / pre-login intake form and is
// unauthenticated by design (an "already-authenticated" redirect only,
// never a login requirement). Every other route under react-app/app was
// re-checked against its own auth guard before this list was written:
// `/` is an unauthenticated D-211 scaffold placeholder, not part of the
// funnel; `/login` and `/contractor/login` are unauthenticated
// auth-utility pages, not funnel or marketing, and `/contractor/login` is
// contractor-namespaced (excluded by the ruling's own words); `/refer`
// requires a signed-in user (redirects to /login otherwise); `/trade-
// selector` is an auth-protected intake wizard by its own docstring and
// redirects unauthenticated visitors back to `/get-started`
// (`useAuthReady` -> `if (!user) window.location.href = GET_STARTED_URL`);
// `/auth-callback` is a transient post-signup token-processing page, not
// marketing/funnel copy; every `/(homeowner)/*`, `/admin/*`,
// `/contractor/*` (other than `/contractor/login`) and `/partner/*` route
// is gated by a shared auth shell (HomeownerShell, ContractorShell,
// RequireAdmin, or an inline `!user` guard) that requires a live session.
// Everything not explicitly listed is denied by default -- adding a route
// here is a deliberate, reviewed decision, same posture as ALLOWED_HOSTS.
const CLARITY_ALLOWED_PATHS = ["/get-started"];

function isClarityAllowedPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return CLARITY_ALLOWED_PATHS.some(p => pathname === p || pathname.startsWith(p + "/"));
}

export function GA4Gate() {
  const pathname = usePathname();
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
      // gh-1939 REWORK: Clarity now requires BOTH the host allowlist above
      // AND the pathname allowlist -- an unauthenticated-funnel route that
      // also does not carry a Supabase auth-fragment token. gtag behaviour
      // (above/below) is completely unaffected by this path check.
      setClarityAllowed(!hasAuthTokenInFragment && isClarityAllowedPath(pathname));
    }
  }, [pathname]);

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
