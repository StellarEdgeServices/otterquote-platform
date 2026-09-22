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
import { LinkedInInsightGate } from './components/LinkedInInsightGate';
import { RedditPixelGate } from './components/RedditPixelGate';
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
 * not support `beforeInteractive` in a non-root page) but scoped to
 * /get-started internally via a pathname check, so it is a no-op on every
 * other route, same posture as GA4Gate's/MetaPixelGate's own path
 * allowlists. window.__oqRouterLeadId (declared in
 * app/types/oq-lead-prefill.d.ts) is read exactly once by
 * get-started/page.tsx's own prefill effect instead of re-parsing
 * location.search, since by the time that effect runs the URL no longer
 * carries `lead`.
 */
const LEAD_STRIP_SCRIPT = `(function () {
  try {
    if (window.location.pathname !== '/get-started') return;
    var params = new URLSearchParams(window.location.search);
    var lead = params.get('lead');
    if (lead) {
      window.__oqRouterLeadId = lead;
      params.delete('lead');
      var qs = params.toString();
      var newUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      history.replaceState(history.state, '', newUrl);
    }
  } catch (e) { /* URL API unavailable: prefill simply won't run this load */ }
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
        {/* LinkedIn Insight Tag — shipped dark/gated (gh-1926), see LinkedInInsightGate */}
        <LinkedInInsightGate />
        {/* Reddit Pixel — shipped dark/gated (gh-1926), see RedditPixelGate */}
        <RedditPixelGate />
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
