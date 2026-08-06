/**
 * Regression test for #504 — /trade-selector auth guard races cookie-only
 * sessions on cold start.
 *
 * Root cause: the page destructured only `loading` from useAuthReady() and
 * redirected to /get-started the instant `loading` flipped false. But
 * AuthProvider's 1.5s `fallbackTimer` deliberately flips `loading:false`
 * WITHOUT setting `settled:true` — it exists specifically so a still-in-
 * flight cross-subdomain cookie recovery (D-212 cold start: session on
 * otterquote.com, empty localStorage on app.otterquote.com) isn't mistaken
 * for "logged out". Every sibling gate (get-started, refer, partner/
 * dashboard, HomeownerShell, ContractorShell) waits for `settled`; trade-
 * selector was the one page that didn't.
 *
 * Style mirrors dashboard.test.tsx: mock @/hooks/use-auth-ready directly
 * (not the full AuthProvider) so each auth phase can be asserted in
 * isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
      }),
    })),
  },
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import TradeSelectorPage from '../page';

type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) => (useAuthReady as unknown as AuthVal).mockReturnValue(v);

describe('TradeSelectorPage — cold-start settled-gate (#504)', () => {
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: '', search: '' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  });

  it('does NOT bounce to /get-started while loading:false but settled:false (the 1.5s fallback-timer window)', async () => {
    // Exactly the state AuthProvider's fallbackTimer produces mid cold-start
    // cookie recovery: the spinner has been lifted (loading:false) but the
    // gate has not made a real decision yet (settled:false).
    mockAuth({ user: null, loading: false, settled: false });
    render(<TradeSelectorPage />);

    // Give any (incorrect) redirect effect a chance to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(window.location.href).toBe('');
  });

  it('redirects to /get-started once settled:true resolves to no user', async () => {
    mockAuth({ user: null, loading: false, settled: true });
    render(<TradeSelectorPage />);

    await waitFor(() => expect(window.location.href).toBe('/get-started'));
  });

  it('does not redirect once settled:true resolves to an authenticated user', async () => {
    mockAuth({ user: { id: 'u1', email: 'jane@example.com' }, loading: false, settled: true });
    render(<TradeSelectorPage />);

    await new Promise((r) => setTimeout(r, 0));

    expect(window.location.href).toBe('');
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });
});
