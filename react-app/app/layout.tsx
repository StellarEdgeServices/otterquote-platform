/**
 * Root layout — D-211
 *
 * Wraps the entire React app with:
 *   1. AuthProvider  — F-007 race-free auth state (INITIAL_SESSION)
 *   2. QueryClientProvider — React Query client singleton (data layer)
 *   3. SentryInitializer — error tracking (D-211 Phase 0)
 *   4. GA4 tag (G-D1Y1TLGEFY) — OtterQuote analytics property
 */

import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';
import { SentryInitializer } from './components/SentryInitializer';
import { AuthProvider } from './providers/auth-provider';
import { QueryClientProvider } from './lib/query-client';

export const metadata: Metadata = {
  title: 'OtterQuote App',
  description: 'OtterQuote — D-211 React app surface',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {/* GA4 — OtterQuote property (G-D1Y1TLGEFY) */}
        <Script
    