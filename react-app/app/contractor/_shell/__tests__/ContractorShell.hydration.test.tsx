/**
 * INTEGRATION test (jsdom) for the ContractorShell cold-load hydration race
 * (Blocker 1, postmortem 2026-06-16). Unlike the unit test (which mocks
 * useAuthReady), this renders the REAL AuthProvider so the provider's
 * getSession() + 1.5s blank-screen fallback timeline is exercised end-to-end. It
 * asserts the shell does NOT bounce an authenticated contractor to
 * /contractor/login during the hydration window — the exact failure that the
 * unit-level "pure logic" tests missed before #291 → #292.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: vi.fn(() => ({ count: 0, loading: false, error: null })),
}));

// Controllable fake Supabase: getSession() resolves via a deferred we resolve by
// hand; onAuthStateChange captures the listener but never fires (the missed-event
// cold load the provider's getSession() path recovers from).
let getSessionDeferred: { promise: Promise<{ data: { session: unknown } }>; resolve: (s: unknown) => void };
function makeDeferred() {
  let resolve!: (s: unknown) => void;
  const promise = new Promise<{ data: { session: unknown } }>((res) => {
    resolve = (session: unknown) => res({ data: { session } });
  });
  return { promise, resolve };
}
const chain = (result: unknown) => ({
  select: () => ({ eq: () => ({ single: () => Promise.resolve(result) }) }),
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      getSession: vi.fn(() => getSessionDeferred.promise),
      signOut: vi.fn(),
    },
    // contractor row present → resolveRole() === 'contractor';
    // template_review_role null → resolveIsAdmin() === false.
    from: vi.fn(() => chain({ data: { id: 'c1', template_review_role: null }, error: null })),
  },
}));

import { AuthProvider } from '@/providers/auth-provider';
import { ContractorShell } from '@/contractor/_shell/ContractorShell';
import { consumeContractorGateBounce } from '@/lib/contractor-gate';

const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64');
const CONTRACTOR_SESSION = {
  user: { id: 'c1', email: 'pro@roofco.com' },
  access_token: `h.${payload}.s`,
};

const flush = async () => {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  getSessionDeferred = makeDeferred();
});

function renderShell() {
  return render(
    <AuthProvider>
      <ContractorShell active="home"><div>dashboard-content</div></ContractorShell>
    </AuthProvider>,
  );
}

describe('ContractorShell × AuthProvider cold-load hydration', () => {
  it('does not bounce an authenticated contractor while the session is still resolving — even after the 1.5s fallback', async () => {
    renderShell();

    // t0: loading — spinner, no bounce.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();

    // Past the provider's 1.5s blank-screen fallback (loading→false, settled stays
    // false). PRE-FIX, the shell bounced HERE.
    await act(async () => { await new Promise((r) => setTimeout(r, 1600)); });
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText('dashboard-content')).not.toBeInTheDocument();

    // getSession() finally resolves with the contractor session → settled.
    await act(async () => { getSessionDeferred.resolve(CONTRACTOR_SESSION); await flush(); });

    expect(screen.getByText('dashboard-content')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(consumeContractorGateBounce()).toBe(false);
  });

  it('bounces to /contractor/login (and marks the one-shot) only once the session definitively resolves to none', async () => {
    renderShell();

    await act(async () => { await new Promise((r) => setTimeout(r, 1600)); });
    expect(replace).not.toHaveBeenCalled(); // fallback fired but not settled → no bounce

    await act(async () => { getSessionDeferred.resolve(null); await flush(); });

    expect(replace).toHaveBeenCalledWith('/contractor/login');
    expect(consumeContractorGateBounce()).toBe(true);
  });
});
