"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

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
// gh-1939 SCOPE EXTENSION (Dustin, 2026-09-16, #1939 comment 5691693161,
// verbatim selected option: "Funnel to bid accept (Recommended)" -- "React
// /trade-selector, project-info (cash/RCV/ACV), repair-intake, dashboard,
// bids, contractor-about. Fields masked. Excluded: contract-signing (the
// signing ceremony), auth-callback, admin, contractor and partner pages.").
// `/trade-selector` is the only React route in that set (the rest are static
// pages gated by js/ga-gate.js). It is authenticated, so its page root
// carries data-clarity-mask="true" -- clarity-route-guard.test.ts fails if
// any authenticated path here loses that attribute. The fragment token guard
// below still runs first on every path.
const CLARITY_ALLOWED_PATHS = ["/get-started", "/trade-selector"];

function isClarityAllowedPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return CLARITY_ALLOWED_PATHS.some(p => pathname === p || pathname.startsWith(p + "/"));
}

// gh-1939 R-1 fix (CEO RUN 47 ruling, refuter report
// ceo47-review-pr1958-20260915.md): the pathname gate above is load-only.
// `setClarityAllowed(false)` unmounts the <Script id="clarity-init"> React
// node, but by then Clarity's snippet has already inserted its own
// <script src=https://www.clarity.ms/tag/...> tag and defined
// `window.clarity`, and unmounting our wrapper node does nothing to either
// of those -- Clarity keeps recording and uploading after a client-side
// (router) navigation off /get-started, even though nothing in this repo
// exercises that path today (D-322 must be held by the gate, not by the
// coincidence that today's only exit from /get-started is a full document
// load).
//
// Runtime measurement (headless Chromium, next build && next start, real
// clarity.js 0.8.69, host-resolver-rules mapping app.otterquote.com --
// see react-app/spa-nav-test.mjs, kept for reviewers and deleted before
// push) found a one-shot `window.clarity('stop')` call is NOT sufficient
// on its own: clarity.js 0.8.69 bundles its OWN SPA-navigation detector
// (an internal poller that runs after every handled DOM event and, on
// seeing `location.href` differ from the value recorded at start, tears
// itself down and automatically RESTARTS a fresh tracking session ~250ms
// later -- config key `restart`, default 250). That auto-restart is not
// exposed or configurable via the public snippet and is not defeated by
// calling `stop()` once, deleting `window.clarity`, or removing the
// injected <script> tag: measured with continued page interaction after
// a client-side nav, a single `stop()` call still produced the SAME
// upload volume over 20s as the unpatched build (6 POSTs to
// .../collect, at ~matching offsets in both runs). Only a PERSISTENT
// counter-poll -- reissuing `clarity('stop')` on an interval while the
// current route stays outside CLARITY_ALLOWED_PATHS -- reliably beat the
// auto-restart in measurement: bounded to the 1-2 POSTs already in
// flight at the moment of navigation, then silent for the rest of a 20s
// window even with continued mouse activity (vs. 6 and climbing
// unpatched). This is still best-effort, not a guarantee for every
// future Clarity build; clarity-route-guard.test.ts documents the
// measured numbers and CLARITY_ALLOWED_PATHS must stay the enforcement
// boundary (i.e. never rely on this teardown alone -- see that test's
// static route-scan for the real backstop).
function stopClarity(): void {
  if (typeof window === "undefined") return;
  try {
    (window as any).clarity?.("stop");
  } catch {
    /* best-effort only */
  }
  document.querySelectorAll('script[src*="clarity.ms"]').forEach(el => el.remove());
  try {
    delete (window as any).clarity;
  } catch {
    (window as any).clarity = undefined;
  }
}

const CLARITY_STOP_POLL_MS = 150;

export function GA4Gate() {
  const pathname = usePathname();
  const [allowed, setAllowed] = useState(false);
  const [clarityAllowed, setClarityAllowed] = useState(false);
  const clarityWasAllowedRef = useRef(false);
  const clarityStopPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      const nextClarityAllowed = !hasAuthTokenInFragment && isClarityAllowedPath(pathname);
      setClarityAllowed(nextClarityAllowed);

      // gh-1939 R-1 fix: stop Clarity (and keep it stopped) the moment a
      // client-side navigation carries it out of CLARITY_ALLOWED_PATHS,
      // instead of relying on the page happening to reload. Only fires on
      // an allowed->disallowed transition, so the first render (already
      // disallowed) does nothing.
      if (nextClarityAllowed) {
        clarityWasAllowedRef.current = true;
        if (clarityStopPollRef.current !== null) {
          clearInterval(clarityStopPollRef.current);
          clarityStopPollRef.current = null;
        }
      } else if (clarityWasAllowedRef.current) {
        clarityWasAllowedRef.current = false;
        stopClarity();
        // Counter-poll: clarity.js 0.8.69's own SPA-navigation auto-restart
        // (see stopClarity's docstring) resurrects tracking on its own
        // ~250ms after the route changes even though we just called
        // stop() -- so keep calling stop() on an interval for as long as
        // the current route is outside CLARITY_ALLOWED_PATHS, cleared the
        // moment the route re-enters the allowlist or this component
        // unmounts.
        if (clarityStopPollRef.current === null) {
          clarityStopPollRef.current = setInterval(stopClarity, CLARITY_STOP_POLL_MS);
        }
      }
    }
  }, [pathname]);

  useEffect(
    () => () => {
      if (clarityStopPollRef.current !== null) {
        clearInterval(clarityStopPollRef.current);
        clarityStopPollRef.current = null;
      }
    },
    []
  );

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
