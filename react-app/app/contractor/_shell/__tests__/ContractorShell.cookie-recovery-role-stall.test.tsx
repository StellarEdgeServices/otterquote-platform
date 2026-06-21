/**
 * REGRESSION test for the D-212 cookie-only contractor hang (ClickUp 86e1yv72z).
 *
 * This is the combination the existing pair never exercised, which is why 746
 * tests stayed green while the bug shipped:
 *   - ContractorShell.safety.test.tsx      → NO cookie + stalled queries → /login
 *   - ContractorShell.cookie-recovery.test → valid cookie + role query RESOLVES → render
 *   - THIS test                            → valid cookie + role query STALLS  → must STILL render
 *
 * Live failure (app.otterquote.com): an authenticated contractor whose session
 * exists ONLY in the cross-subdomain sb-otterquote-at/rt cookie (app-origin
 * localStorage empty/stale) lands on /contractor/dashboard. getSession() hangs on
 * the orphaned auth lock; the 6s backstop recovers the valid cookie and re-enters
 * resolveSession — but role/admin resolution ALSO stalls in that same hung-auth
 * window, so `settled` never flips true and the gate spins forever (12s+). It does
 * NOT bounce (PR #326) and never renders. The fix bounds role resolution so the
 * provider always settles to an AUTHENTICATED render (null role is not-blocked;
 * page-level RLS remains the authority).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: vi.fn(() => ({ count: 0, loading: false, error: null })),
}));

// getSession() never resolves (orphaned-lock hang) AND the contractors/profiles
// role query never resolves (the same hung-auth window). The ONLY route to a
// settled state is the cookie-recovery backstop — which must not strand on Loading.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      getSession: vi.fn(() => new Promise(() => {})),
      signOut: vi.fn(),
    },
    from: vi.fn(() => ({ select: () => ({ eq: () => ({ single: () => new Promise(() => {}) }) }) })),
  },
}));

import { AuthProvider, useAuth } from '@/providers/auth-provider';
import { ContractorShell } from '@/contractor/_shell/ContractorShell';
import { _COOKIE_ACCESS, _COOKIE_REFRESH, OTTERQUOTE_AUTH_STORAGE_KEY } from '@/lib/cookie-storage';

function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
}
function setCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/`;
}
function clearCookies(): void {
  for (const pair of document.cookie.split('; ')) {
    const k = pair.split('=')[0];
    if (k) document.cookie = `${k}=; path=/; max-age=0`;
  }
}

const NOW = Math.floor(Date.now() / 1000);

// Surfaces the provider's settle decision so the test can assert the provider
// itself reached an authenticated, settled state (not just that the shell painted).
let captured: { settled: boolean; loading: boolean; userId: string | null } | null = null;
function AuthProbe() {
  const { settled, loading, user } = useAuth();
  captured = { settled, loading, userId: user ? user.id : null };
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  clearCookies();
  sessionStorage.clear();
  localStorage.clear();
  captured = null;
});
afterEach(() => {
  vi.useRealTimers();
  clearCookies();
  localStorage.clear();
});

describe('ContractorShell × AuthProvider — valid cookie survives a hung getSession AND a stalled role query (86e1yv72z)', () => {
  it('settles to an AUTHENTICATED render instead of spinning forever', async () => {
    // app-origin localStorage holds a STALE, different-user token (the live state).
    localStorage.setItem(
      OTTERQUOTE_AUTH_STORAGE_KEY,
      JSON.stringify({ access_token: makeJwt({ sub: 'other-user', exp: NOW - 3600 }), refresh_token: 'stale' }),
    );
    // The valid shared cross-subdomain session lives ONLY in the cookie.
    setCookie(_COOKIE_ACCESS, makeJwt({ sub: 'c1', email: 'pro@roofco.com', exp: NOW + 3600, iat: NOW, email_verified: true }));
    setCookie(_COOKIE_REFRESH, 'refresh-token-abc');

    render(
      <AuthProvider>
        <AuthProbe />
        <ContractorShell active="home"><div>dashboard-content</div></ContractorShell>
      </AuthProvider>,
    );

    // Past the 1.5s blank-screen fallback: still resolving (settled false) → NO bounce.
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(replace).not.toHaveBeenCalled();

    // Past the 6s settle-safety backstop AND the bounded role-resolution window:
    // the cookie session is recovered and the gate settles AUTHENTICATED.
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

    // The provider settled to an authenticated state for the cookie's user…
    expect(captured?.settled).toBe(true);
    expect(captured?.loading).toBe(false);
    expect(captured?.userId).toBe('c1');
    // …the gate rendered the page (never the infinite spinner) and never bounced.
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText('dashboard-content')).toBeInTheDocument();
  });
});
