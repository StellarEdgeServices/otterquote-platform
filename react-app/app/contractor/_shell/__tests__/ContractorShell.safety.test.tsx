/**
 * INTEGRATION test for the AuthProvider settle-safety backstop (D-211, 2026-06-16).
 * If getSession() never resolves (e.g. an orphaned Supabase Web Lock — the true
 * root of Blocker 1), the gate must FAIL SAFE to /contractor/login after the
 * backstop window rather than spin forever. Pairs with the supabase-lock fix that
 * prevents the hang in the first place.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: vi.fn(() => ({ count: 0, loading: false, error: null })),
}));

// getSession() never resolves — simulates the orphaned-lock hang.
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

import { AuthProvider } from '@/providers/auth-provider';
import { ContractorShell } from '@/contractor/_shell/ContractorShell';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AuthProvider settle-safety backstop (getSession hang)', () => {
  it('does not bounce prematurely, then fails safe to /contractor/login (no infinite spinner)', async () => {
    render(
      <AuthProvider>
        <ContractorShell active="home"><div>dashboard-content</div></ContractorShell>
      </AuthProvider>,
    );

    // Past the 1.5s blank-screen fallback: still resolving (settled false) → NO bounce.
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(replace).not.toHaveBeenCalled();

    // Past the 6s settle-safety backstop: gate fails safe to login instead of hanging.
    await act(async () => { await vi.advanceTimersByTimeAsync(4600); });
    expect(replace).toHaveBeenCalledWith('/contractor/login');
  });
});
