/**
 * gh-2121 (LRS HO-1 S16) / PR #2163 REVIEW: FAIL fix (comment 5821864061,
 * M1): HomeownerShell's unauthenticated redirect must carry a captured
 * lead id across the cross-origin bounce to otterquote.com/get-started.html
 * (which 301s straight back to app.otterquote.com/get-started — see
 * _redirects) as a `?lead=` query param, since sessionStorage set on
 * app.otterquote.com is not guaranteed to read back reliably across a hop
 * through another origin in every browser.
 *
 * Unit-level (mocked useAuthReady), same pattern as dashboard.test.tsx's
 * "HomeownerShell gate" describe block — NOT the AuthProvider integration
 * tests (HomeownerShell.cold-start.test.tsx / .role-resolution.test.tsx),
 * which cover the auth-timing races this file does not touch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: () => ({ count: 0, loading: false, error: null }),
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import { HomeownerShell, HOMEOWNER_GET_STARTED_URL } from '../HomeownerShell';

type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) => (useAuthReady as unknown as AuthVal).mockReturnValue(v);

const unauthed = () => ({
  user: null,
  role: null,
  isAdmin: false,
  loading: false,
  settled: true,
  signOut: vi.fn(),
});

describe('HomeownerShell: unauthenticated redirect carries a captured lead id', () => {
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockAuth(unauthed());
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: '' },
    });
  });

  afterEach(() => {
    sessionStorage.clear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it('appends ?lead=<id> when a pending lead was captured', async () => {
    sessionStorage.setItem('oq_pending_lead', JSON.stringify({ id: 'lead-xyz', exp: Date.now() + 60000 }));

    render(
      <HomeownerShell active="dashboard">
        <div>content</div>
      </HomeownerShell>,
    );

    await waitFor(() => expect(window.location.href).toBe(`${HOMEOWNER_GET_STARTED_URL}?lead=lead-xyz`));
  });

  it('negative control: no pending lead -> redirects with no ?lead= param', async () => {
    render(
      <HomeownerShell active="dashboard">
        <div>content</div>
      </HomeownerShell>,
    );

    await waitFor(() => expect(window.location.href).toBe(HOMEOWNER_GET_STARTED_URL));
  });

  it('negative control: an EXPIRED pending lead is not appended', async () => {
    sessionStorage.setItem('oq_pending_lead', JSON.stringify({ id: 'lead-stale', exp: Date.now() - 1 }));

    render(
      <HomeownerShell active="dashboard">
        <div>content</div>
      </HomeownerShell>,
    );

    await waitFor(() => expect(window.location.href).toBe(HOMEOWNER_GET_STARTED_URL));
  });
});
