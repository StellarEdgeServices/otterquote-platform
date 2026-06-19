/**
 * INTEGRATION test for the D-212 session-precedence fix: a valid shared cookie
 * session must NOT be fail-closed to /contractor/login when supabase getSession()
 * is slow or hung (orphaned-lock window). The AuthProvider fail-safe recovers the
 * session from the sb-otterquote-at/rt cookie (readValidCookieSession) and resolves
 * the authenticated contractor instead of ejecting them.
 *
 * Pairs with ContractorShell.safety.test.tsx, which proves the SAME backstop window
 * still fails safe to /login when there is NO valid cookie session to recover.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: vi.fn(() => ({ count: 0, loading: false, error: null })),
}));

// getSession() never resolves (the orphaned-lock hang). The contractors role query
// DOES resolve, so the only route to a settled state is the cookie-recovery path.
const chain = (result: unknown) => ({
  select: () => ({ eq: () => ({ single: () => Promise.resolve(result) }) }),
});
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      getSession: vi.fn(() => new Promise(() => {})),
      signOut: vi.fn(),
    },
    from: vi.fn(() => chain({ data: { id: 'c1', template_review_role: null }, error: null })),
  },
}));

import { AuthProvider } from '@/providers/auth-provider';
import { ContractorShell } from '@/contractor/_shell/ContractorShell';
import { _COOKIE_ACCESS, _COOKIE_REFRESH } from '@/lib/cookie-storage';

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  clearCookies();
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  clearCookies();
});

describe('ContractorShell × AuthProvider — valid cookie survives a hung getSession (D-212)', () => {
  it('recovers the cookie session in the fail-safe window instead of bouncing to /contractor/login', async () => {
    setCookie(_COOKIE_ACCESS, makeJwt({ sub: 'c1', email: 'pro@roofco.com', exp: NOW + 3600, iat: NOW, email_verified: true }));
    setCookie(_COOKIE_REFRESH, 'refresh-token-abc');

    render(
      <AuthProvider>
        <ContractorShell active="home"><div>dashboard-content</div></ContractorShell>
      </AuthProvider>,
    );

    // Past the 1.5s blank-screen fallback: still resolving (settled false) → NO bounce.
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(replace).not.toHaveBeenCalled();

    // Past the 6s settle-safety backstop: the cookie session is recovered, the role
    // query flushes, and the authenticated contractor is admitted — NOT bounced.
    await act(async () => { await vi.advanceTimersByTimeAsync(4600); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText('dashboard-content')).toBeInTheDocument();
  });
});
