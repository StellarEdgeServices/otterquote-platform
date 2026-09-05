/**
 * Root layout — D-211
 *
 * Wraps the entire React app with:
 *   1. AuthProvider  — F-007 race-free auth state (INITIAL_SESSION)
 *   2. QueryClientProvider — React Query client singleton (data layer)
 *   3. SentryInitializer — error tracking (D-211 Phase 0)
 */

import type { Metadata } from 'next';
import './globals.css';
import { GA4Gate } from './components/GA4Gate';
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
        {/* GA4 — OtterQuote property; host-gated (gh-1619), see GA4Gate */}
        <GA4Gate />
        <SentryInitializer />
        <QueryClientProvider>
          <AuthProvider>{children}</AuthProvider>
        </QueryClientProvider>
      </body>
    </html>
  );
}
