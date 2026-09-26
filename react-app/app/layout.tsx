/**
 * Root layout — D-211
 *
 * Wraps the entire React app with:
 *   1. AuthProvider  — F-007 race-free auth state (INITIAL_SESSION)
 *   2. QueryClientProvider — React Query client singleton (data layer)
 *   3. SentryInitializer — error tracking (D-211 Phase 0)
 */

import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';
import { AttributionCapture } from './components/AttributionCapture';
import { GA4Gate } from './components/GA4Gate';
import { MetaPixelGate } from './components/MetaPixelGate';
import { SentryInitializer } from './components/SentryInitializer';
import { AuthProvider } from './providers/auth-provider';
import { QueryClientProvider } from './lib/query-client';

export const metadata: Metadata = {
  title: 'Otter Quotes App',
  description: 'Otter Quotes — D-211 React app surface',
};

/**
 * gh-2046: capture ?lead=<uuid> and strip it from the visible URL via
 * history.replaceState BEFORE any analytics initialisation runs (GA4Gate,
 * MetaPixelGate, SentryInitializer below — and anything those mount, e.g.
 * gtag.js/fbevents.js/Clarity's own automatic page_view/pageview call, which
 * reads the CURRENT URL at the moment that library's script runs). Mirrors
 * the existing static-page pattern (see contractor-join.html and its
 * siblings) exactly, adapted to this app's one mechanism for guaranteeing
 * that ordering: next/script's `beforeInteractive` strategy, which Next.js
 * only supports declaring in the root layout and which executes during
 * initial HTML parse — before hydration, and therefore before every
 * useEffect in this tree (GA4Gate/MetaPixelGate/SentryInitializer included)
 * can possibly run. That is what makes this a strip rather than a race: an
 * effect-based strip inside get-started/page.tsx would run AFTER those
 * gates' own effects (React fires sibling effects in JSX order, and the
 * gates are earlier siblings than {children}), which is exactly the trap
 * this file avoids by not doing that.
 *
 * Declared globally (root layout, not get-started/page.tsx — Next.js does
 * not support `beforeInteractive` in a non-root page) but scoped internally
 * via a pathname allowlist, so it is a no-op on every other route, same
 * posture as GA4Gate's/MetaPixelGate's own path allowlists.
 * window.__oqRouterLeadId (declared in app/types/oq-lead-prefill.d.ts)
 * still carries the id for same-page-load reads (get-started/page.tsx's
 * prefill effect).
 *
 * PR #2163 REVIEW: FAIL (comment 5821864061, M1) fix, 2026-09-24: this used
 * to run on /get-started only, so it was a no-op on the two pages Arm F's
 * thank-you CTAs actually deep-link to — app.otterquote.com/help-
 * measurements?lead=<id> and .../help-estimate?lead=<id>
 * (js/router-variant-f.js:115-116,592-595) — and `lead` stayed in the
 * visible URL there while GA4Gate/MetaPixelGate/SentryInitializer mounted
 * (the gh-2046 exposure again, on the two pages gh-2046 didn't cover). Now
 * runs on all three landing paths (LEAD_CAPTURE_PATHS, shared with
 * lib/lead-capture.ts's reader so the two stay in lockstep), and ALSO
 * persists the id to sessionStorage (LEAD_STORAGE_KEY, with an expiry
 * marker — LEAD_TTL_MS) so a later page load — after the help page's own
 * React tree has mounted and window.__oqRouterLeadId from THIS load is
 * long gone — can still read it (lib/lead-capture.ts's
 * readPendingLeadId()). The key/TTL literals are duplicated here rather
 * than imported: this string is emitted as a `beforeInteractive` inline
 * script, outside the module graph, so it cannot `import` anything.
 */
const LEAD_STORAGE_KEY = 'oq_pending_lead';
const LEAD_CAPTURE_PATHS = ['/get-started', '/help-measurements', '/help-estimate'];
const LEAD_TTL_MS = 30 * 60 * 1000;

const LEAD_STRIP_SCRIPT = `(function () {
  try {
    var paths = ${JSON.stringify(LEAD_CAPTURE_PATHS)};
    if (paths.indexOf(window.location.pathname) === -1) return;
    var params = new URLSearchParams(window.location.search);
    var lead = params.get('lead');
    if (lead) {
      window.__oqRouterLeadId = lead;
      try {
        sessionStorage.setItem(${JSON.stringify(LEAD_STORAGE_KEY)}, JSON.stringify({ id: lead, exp: Date.now() + ${LEAD_TTL_MS} }));
      } catch (e) { /* storage unavailable (private mode / quota) — window var still works this load */ }
      params.delete('lead');
      var qs = params.toString();
      var newUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      history.replaceState(history.state, '', newUrl);
    }
  } catch (e) { /* URL API unavailable: capture simply won't run this load */ }
})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {/* gh-2046: must stay the first script below — see LEAD_STRIP_SCRIPT's
            comment above for why ordering here is the entire security
            property. */}
        <Script id="oq-lead-strip" strategy="beforeInteractive">
          {LEAD_STRIP_SCRIPT}
        </Script>
        {/* GA4 — OtterQuote property; host-gated (gh-1619), see GA4Gate */}
        <GA4Gate />
        {/* Meta Pixel — OtterQuote property; host-gated (gh-1817), see MetaPixelGate */}
        <MetaPixelGate />
        <SentryInitializer />
        {/* gh-1983 — first-touch ad attribution (client fallback to the server cookie) */}
        <AttributionCapture />
        <QueryClientProvider>
          <AuthProvider>{children}</AuthProvider>
        </QueryClientProvider>
      </body>
    </html>
  );
}
