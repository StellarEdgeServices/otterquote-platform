'use client';

import {
  QueryClient,
  QueryClientProvider as TanstackQueryClientProvider,
  DefaultError,
} from '@tanstack/react-query';
import { ReactNode } from 'react';

/**
 * React Query client singleton with documented defaults for OtterQuote.
 *
 * Defaults:
 * - staleTime: 30s (claims data changes infrequently)
 * - retry: 2 (transient Supabase errors are common; 3 total attempts)
 * - refetchOnWindowFocus: true (stay in sync when tab regains focus)
 * - gcTime: 5min (5 minute cache before garbage collection)
 *
 * Global error handler: logs to console in dev, silent in prod.
 */

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // 30 seconds
      retry: 2, // 3 total attempts (initial + 2 retries)
      refetchOnWindowFocus: true,
      gcTime: 5 * 60 * 1000, // 5 minutes
    },
  },
});

/**
 * Global error handler for all queries.
 * Logs in dev, silent in prod.
 */
queryClient.getDefaultOptions = () => ({
  ...queryClient.getDefaultOptions(),
  queries: {
    ...queryClient.getDefaultOptions().queries,
    meta: {
      onError: (error: DefaultError) => {
        if (process.env.NODE_ENV === 'development') {
          console.error('[React Query Error]', error);
        }
      },
    },
  },
});

/**
 * QueryClientProvider wrapper component.
 *
 * Wrap your app's root with:
 * <QueryClientProvider client={queryClient}>
 *   <App />
 * </QueryClientProvider>
 */
export function QueryClientProvider({ children }: { children: ReactNode }) {
  return (
    <TanstackQueryClientProvider client={queryClient}>
      {children}
    </TanstackQueryClientProvider>
  );
}
