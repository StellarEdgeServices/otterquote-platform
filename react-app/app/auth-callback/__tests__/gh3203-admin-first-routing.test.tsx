/**
 * gh-3203 -- an allowlisted admin (public.is_admin_email() === true) is routed to admin BEFORE the
 * derived role, so a login that also has a contractors row (derived_role 'contractor') or a homeowner
 * claim does not land on a contractor/homeowner page.
 *   (1) admin + derived contractor -> admin landing (fails on main: goes to contractor dashboard)
 *   (2) admin + derived homeowner  -> admin landing (fails on main: goes to /trade-selector)
 *   (3) non-admin contractor       -> contractor dashboard (negative control)
 *   (4) is_admin_email errors      -> normal routing (fail closed)
 *   (5) is_admin_email returns a truthy non-true value -> normal routing
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const { state } = vi.hoisted(() => ({
  state: { derived: 'contractor' as string, admin: { data: true as unknown, error: null as unknown } },
}));

vi.mock('@/lib/supabase', () => {
  const chain = (getResult: () => { data: unknown; error: unknown }) => {
    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.limit = vi.fn(() => b);
    b.maybeSingle = vi.fn(() => Promise.resolve(getResult()));
    return b;
  };
  return {
    supabase: {
      auth: { onAuthStateChange: vi.fn() },
      rpc: vi.fn((fn: string) =>
        fn === 'is_admin_email'
          ? Promise.resolve({ ...state.admin, status: 200 })
          : Promise.resolve({ data: true, error: null, status: 200 }),
      ),
      from: vi.fn((table: string) =>
        table === 'resolved_user_role'
          ? chain(() => ({ data: { derived_role: state.derived }, error: null }))
          : chain(() => ({ data: null, error: null })),
      ),
      functions: { invoke: vi.fn(() => Promise.resolve({ error: null })) },
    },
  };
});

vi.mock('@/lib/cookie-storage', () => ({
  readReferralIds: vi.fn(() => ({})),
  writeReferralIds: vi.fn(),
  writeClaimReferralId: vi.fn(),
}));
vi.mock('../signup-analytics', () => ({
  maybeFireGoogleSignUp: vi.fn(() => Promise.resolve(false)),
  readReferralSourceFromCsSignup: vi.fn(() => null),
}));

import { supabase } from '@/lib/supabase';
import AuthCallbackPage from '../page';

type Fn = ReturnType<typeof vi.fn>;
const ADMIN = 'https://app.otterquote.com/admin/contractors';
const CONTRACTOR = 'https://otterquote.com/contractor-dashboard.html';
const session = { user: { id: 'u1', email: 'admin@example.test', app_metadata: { provider: 'email' }, user_metadata: {} } };

describe('auth-callback gh-3203 admin-first routing', () => {
  let hrefSpy: Fn;
  let originalLocation: PropertyDescriptor | undefined;
  let fire: ((event: string, s: unknown) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    state.derived = 'contractor';
    state.admin = { data: true, error: null };
    hrefSpy = vi.fn();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hash: '', search: '', set href(v: string) { hrefSpy(v); } },
    });
    fire = undefined;
    (supabase.auth.onAuthStateChange as unknown as Fn).mockImplementation((cb) => {
      fire = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
  });
  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  });

  async function signIn() {
    render(<AuthCallbackPage />);
    await waitFor(() => expect(fire).toBeDefined());
    fire?.('SIGNED_IN', session);
  }

  it('(1) admin whose derived role is contractor lands on admin', async () => {
    await signIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith(ADMIN));
    expect(hrefSpy).not.toHaveBeenCalledWith(CONTRACTOR);
  });

  it('(2) admin whose derived role is homeowner lands on admin, not the trade selector', async () => {
    state.derived = 'homeowner';
    await signIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith(ADMIN));
    expect(hrefSpy).not.toHaveBeenCalledWith('/trade-selector');
  });

  it('(3) negative control: a non-admin contractor still goes to the contractor dashboard', async () => {
    state.admin = { data: false, error: null };
    await signIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith(CONTRACTOR));
    expect(hrefSpy).not.toHaveBeenCalledWith(ADMIN);
  });

  it('(4) is_admin_email errors -> fails closed to normal routing', async () => {
    state.admin = { data: null, error: { message: 'boom' } };
    await signIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith(CONTRACTOR));
    expect(hrefSpy).not.toHaveBeenCalledWith(ADMIN);
  });

  it('(5) a truthy non-true answer is not admin', async () => {
    state.admin = { data: 'true', error: null };
    await signIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith(CONTRACTOR));
    expect(hrefSpy).not.toHaveBeenCalledWith(ADMIN);
  });
});
