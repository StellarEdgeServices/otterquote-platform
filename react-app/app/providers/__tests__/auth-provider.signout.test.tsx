/**
 * D-211 P33 — deterministic logout (86e20pdta).
 *
 * Proves AuthProvider.signOut() FORCE-CLEARS the cross-subdomain auth cookies via
 * otterquoteCookieStorage.removeItem() in a `finally`, so the clear happens whether
 * the supabase-js signOut() promise RESOLVES or REJECTS. Pre-fix, signOut() used the
 * DEFAULT global scope and leaned entirely on the network revoke firing SIGNED_OUT;
 * a failed/offline/5xx revoke returned early WITHOUT removing the local session, so
 * sb-otterquote-at / sb-otterquote-rt (Domain=.otterquote.com) AND host-only sb_at
 * survived and readValidCookieSession() recovered the session on next navigation.
 *
 * Style mirrors HomeownerShell.cold-start.test.tsx: mock ONLY @/lib/supabase, render
 * the REAL AuthProvider, and keep cookie-storage real so removeItem actually deletes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

// Controllable supabase.auth.signOut — resolve in one test, reject in the other.
// vi.hoisted lifts the spy alongside the hoisted vi.mock factory so the factory can
// safely reference it without a temporal-dead-zone error.
const { supabaseSignOut } = vi.hoisted(() => ({ supabaseSignOut: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      // Capture-and-ignore: the provider subscribes on mount; we never drive events.
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      // Hang so the provider stays in its initial loading state and never runs role
      // lookups — signOut from context is available regardless of settle timing.
      getSession: vi.fn(() => new Promise(() => {})),
      signOut: supabaseSignOut,
    },
    from: vi.fn(() => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) })),
  },
}));

import { AuthProvider, useAuth } from '@/providers/auth-provider';
import {
  otterquoteCookieStorage,
  OTTERQUOTE_AUTH_STORAGE_KEY,
  _COOKIE_ACCESS,
  _COOKIE_REFRESH,
} from '@/lib/cookie-storage';

// Capture the live signOut from context for direct invocation.
let capturedSignOut: (() => Promise<void>) | null = null;
function Consumer() {
  capturedSignOut = useAuth().signOut;
  return null;
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
// Seed the exact cookies a logged-in session leaves behind.
function seedAuthCookies(): void {
  setCookie(_COOKIE_ACCESS, 'access-token-abc');
  setCookie(_COOKIE_REFRESH, 'refresh-token-abc');
  setCookie('sb_at', 'access-token-abc');
}

let removeItemSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  capturedSignOut = null;
  clearCookies();
  try { window.localStorage.clear(); } catch { /* ignore */ }
  // Spy WITHOUT replacing the implementation — the real removeItem still deletes the
  // cross-subdomain cookies, so we assert both the call AND the actual cookie removal.
  removeItemSpy = vi.spyOn(otterquoteCookieStorage, 'removeItem');
  supabaseSignOut.mockReset();
});

afterEach(() => {
  removeItemSpy.mockRestore();
  clearCookies();
  try { window.localStorage.clear(); } catch { /* ignore */ }
});

describe('AuthProvider.signOut — deterministic session clear (D-211 P33, 86e20pdta)', () => {
  it('uses scope:"local" and force-clears the auth cookies when the revoke RESOLVES', async () => {
    supabaseSignOut.mockResolvedValue({ error: null });
    seedAuthCookies();
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    expect(capturedSignOut).toBeTypeOf('function');

    await capturedSignOut!();

    // No network-revoke scope: the local clear cannot be stranded by a failed revoke.
    expect(supabaseSignOut).toHaveBeenCalledWith({ scope: 'local' });
    // The force-clear fired exactly once with the canonical storage key.
    expect(removeItemSpy).toHaveBeenCalledTimes(1);
    expect(removeItemSpy).toHaveBeenCalledWith(OTTERQUOTE_AUTH_STORAGE_KEY);
    // Cross-subdomain + host-only cookies are gone.
    expect(document.cookie).not.toContain(_COOKIE_ACCESS);
    expect(document.cookie).not.toContain(_COOKIE_REFRESH);
    expect(document.cookie).not.toContain('sb_at=');
  });

  it('STILL force-clears the auth cookies when the revoke REJECTS (offline/5xx/timeout)', async () => {
    // The whole point of 86e20pdta: a revoke that throws must not strand the cookies.
    supabaseSignOut.mockRejectedValue(new Error('network down'));
    seedAuthCookies();
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    expect(capturedSignOut).toBeTypeOf('function');

    // signOut re-throws after the finally; the determinism guarantee is the clear, not
    // a swallowed error — so we tolerate the rejection and assert the cookies are gone.
    await capturedSignOut!().catch(() => undefined);

    expect(supabaseSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(removeItemSpy).toHaveBeenCalledTimes(1);
    expect(removeItemSpy).toHaveBeenCalledWith(OTTERQUOTE_AUTH_STORAGE_KEY);
    expect(document.cookie).not.toContain(_COOKIE_ACCESS);
    expect(document.cookie).not.toContain(_COOKIE_REFRESH);
    expect(document.cookie).not.toContain('sb_at=');
  });
});
