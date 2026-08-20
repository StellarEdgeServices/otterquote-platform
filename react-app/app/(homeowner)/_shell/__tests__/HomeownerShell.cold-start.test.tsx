/**
 * INTEGRATION test (jsdom) for the D-211 HomeownerShell cold-start hydration
 * bounce (ClickUp 86e1zpryf). Renders the REAL AuthProvider so the provider's
 * INITIAL_SESSION + getSession timeline is exercised end-to-end, NOT the mocked
 * useAuthReady the unit-level dashboard test uses.
 *
 * Repro: on the FIRST app.otterquote.com load in a fresh context the valid
 * .otterquote.com cookie session (sb-otterquote-at/rt) is present, but supabase-js
 * emits INITIAL_SESSION with session=null while storage/lock is still priming —
 * ahead of the getSession() that would return the reconstructed cookie session.
 * PRE-FIX the provider settled {user:null, settled:true} on that null event and the
 * homeowner gate hard-redirected an AUTHENTICATED user to get-started.html.
 *
 * POST-FIX the provider recovers the valid cookie session on the primary resolve
 * path (readValidCookieSession precedence, shared with the contractor track via the
 * same AuthProvider), so the gate shows the spinner, then resolves to the correct
 * destination once hydrated. The gate is NOT weakened: a cold start with NO valid
 * cookie still settles unauthenticated and still bounces to get-started.html.
 *
 * Pairs with the unit-level gate assertions in
 * app/(homeowner)/dashboard/__tests__/dashboard.test.tsx (mocked useAuthReady) and
 * mirrors app/contractor/_shell/__tests__/ContractorShell.hydration.test.tsx.
 *
 * gh-909 (D-182 v113, 2026-08-19) update: resolveRole() now makes a single
 * `resolved_user_role` query instead of contractors -> profiles.role, so `roleRows`
 * below is keyed by 'resolved_user_role' with a `{ derived_role: <value> }` payload
 * (the view's own precedence — branch-tested — already resolves contractor/partner/
 * claims/profile-fallback server-side; these fixtures just seed its final answer).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: vi.fn(() => ({ count: 0, loading: false, error: null })),
}));

// Capture the onAuthStateChange callback so the test can drive INITIAL_SESSION by
// hand. getSession() hangs (never resolves) so the ONLY route to a settled state is
// the INITIAL_SESSION(null) → cookie-recovery path — isolating the cold-start race.
// `roleRows` is read lazily at from() call time, so per-test role wiring works
// despite the factory being hoisted above the imports.
let authCb: ((event: string, session: unknown) => void | Promise<void>) | null = null;
let roleRows: Record<string, { data: unknown; error: unknown }> = {};

const chain = (result: { data: unknown; error: unknown }) => ({
  select: () => ({ eq: () => ({ single: () => Promise.resolve(result) }) }),
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
        authCb = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      getSession: vi.fn(() => new Promise(() => {})), // hangs — INITIAL_SESSION drives resolution
      signOut: vi.fn(),
    },
    from: vi.fn((table: string) => chain(roleRows[table] ?? { data: null, error: { message: 'no rows' } })),
  },
}));

import { AuthProvider } from '@/providers/auth-provider';
import { HomeownerShell } from '../HomeownerShell';
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
function setValidCookieSession(email: string): void {
  const NOW = Math.floor(Date.now() / 1000);
  setCookie(_COOKIE_ACCESS, makeJwt({ sub: 'u1', email, exp: NOW + 3600, iat: NOW, email_verified: true }));
  setCookie(_COOKIE_REFRESH, 'refresh-token-abc');
}

const flush = async () => {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
};

let originalLocation: Location;

beforeEach(() => {
  vi.clearAllMocks();
  authCb = null;
  roleRows = {};
  clearCookies();
  try { window.localStorage.clear(); } catch { /* ignore */ }
  originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: '' },
  });
});

afterEach(() => {
  clearCookies();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

function renderShell() {
  return render(
    <AuthProvider>
      <HomeownerShell active="dashboard"><div>DASH_BODY</div></HomeownerShell>
    </AuthProvider>,
  );
}

describe('HomeownerShell × AuthProvider — cold-start hydration (D-211 86e1zpryf)', () => {
  it('does NOT bounce to get-started.html on a null INITIAL_SESSION when a valid contractor cookie is present — resolves to the contractor dashboard', async () => {
    // The live repro user is a contractor visiting a homeowner page: warm load
    // correctly sends them to contractor-dashboard.html; cold load PRE-FIX ejected
    // them to get-started.html instead.
    roleRows = { resolved_user_role: { data: { derived_role: 'contractor' }, error: null } };
    setValidCookieSession('pro@roofco.com');

    renderShell();

    // t0: cold — spinner, NO premature redirect.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(window.location.href).toBe('');

    // The cold-start race: INITIAL_SESSION arrives with session=null before the
    // cookie session has loaded. PRE-FIX this settled user:null and bounced.
    await act(async () => { await authCb!('INITIAL_SESSION', null); await flush(); });

    // POST-FIX: cookie session recovered → authenticated contractor → the gate sends
    // them to the contractor dashboard, and NEVER to get-started.html.
    await waitFor(() =>
      expect(window.location.href).toBe('https://otterquote.com/contractor-dashboard.html'),
    );
    expect(window.location.href).not.toContain('get-started.html');
    expect(screen.queryByText('DASH_BODY')).not.toBeInTheDocument();
  });

  it('admits an authenticated homeowner on a cold start (null INITIAL_SESSION, valid homeowner cookie)', async () => {
    roleRows = {
      resolved_user_role: { data: { derived_role: 'homeowner' }, error: null },
    };
    setValidCookieSession('jane@example.com');

    renderShell();
    expect(screen.getByRole('status')).toBeInTheDocument();

    await act(async () => { await authCb!('INITIAL_SESSION', null); await flush(); });

    await waitFor(() => expect(screen.getByText('DASH_BODY')).toBeInTheDocument());
    expect(window.location.href).toBe(''); // no redirect of any kind
  });

  it('still bounces a genuinely logged-out cold start (null INITIAL_SESSION, NO cookie) to get-started.html — gate not weakened', async () => {
    // No cookie set → readValidCookieSession() returns null → settle unauthenticated.
    renderShell();

    await act(async () => { await authCb!('INITIAL_SESSION', null); await flush(); });

    await waitFor(() => expect(window.location.href).toBe('https://otterquote.com/get-started.html'));
    expect(window.location.href).not.toContain('sign-in.html');
    expect(screen.queryByText('DASH_BODY')).not.toBeInTheDocument();
  });
});
