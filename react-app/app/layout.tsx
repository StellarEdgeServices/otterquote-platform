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
import { SentryInitializer } from './components/SentryInitializer';
import { AuthProvider } from './providers/auth-provider';
import { QueryClientProvider } from './lib/query-client';

export const metadata: Metadata = {
  title: 'Otter Quotes App',
  description: 'Otter Quotes — D-211 React app surface',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {/* GA4 — OtterQuote property; window.gtag consumers are guarded (types/gtag.d.ts) */}
        <Script
          async
          src="https://www.googletagmanager.com/gtag/js?id=G-D1Y1TLGEFY"
          strategy="afterInteractive"
        />
        <Script id="ga4-init" strategy="afterInteractive">
          {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-D1Y1TLGEFY');`}
        </Script>
        <SentryInitializer />
        <QueryClientProvider>
          <AuthProvider>{children}</AuthProvider>
        </QueryClientProvider>
      </body>
    </html>
  );
}
