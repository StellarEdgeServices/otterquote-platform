/**
 * Wiring tests for the auth-callback landing page (gh-1940 fix2).
 *
 * These do NOT re-test maybeFireGoogleSignUp's own guard logic (see
 * signup-analytics.test.ts for that) — they assert the page's WIRING:
 *   - the landing fires the Google sign_up guard exactly once per
 *     routeSession, with the referral_source read from cs_signup;
 *   - the redirect is awaited behind it (kills mutant M1: deleting this
 *     call site would make "exactly once" assertions here vacuous/fail,
 *     since the mock would never be called at all).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { LEAD_STORAGE_KEY, LEAD_TTL_MS } from '@/lib/lead-capture';

vi.mock('@/lib/supabase', () => {
  const chain = (result: { data: unknown; error: unknown }) => {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.order = vi.fn(() => builder);
    builder.limit = vi.fn(() => builder);
    builder.maybeSingle = vi.fn(() => Promise.resolve(result));
    return builder;
  };
  return {
    supabase: {
      auth: { onAuthStateChange: vi.fn() },
      rpc: vi.fn(() => Promise.resolve({ data: true, error: null, status: 200 })),
      from: vi.fn((table: string) => {
        if (table === 'resolved_user_role') {
          return chain({ data: { derived_role: 'homeowner' }, error: null });
        }
        if (table === 'claims') {
          return chain({ data: null, error: null }); // no existing claim -> trade-selector
        }
        return chain({ data: null, error: null });
      }),
      functions: { invoke: vi.fn(() => Promise.resolve({ error: null })) },
    },
  };
});

vi.mock('@/lib/cookie-storage', () => ({
  readReferralIds: vi.fn(() => ({})),
  writeReferralIds: vi.fn(),
}));

vi.mock('../signup-analytics', () => ({
  maybeFireGoogleSignUp: vi.fn(),
  readReferralSourceFromCsSignup: vi.fn(() => 'realtor'),
}));

import { supabase } from '@/lib/supabase';
import { maybeFireGoogleSignUp } from '../signup-analytics';
import AuthCallbackPage from '../page';

type Fn = ReturnType<typeof vi.fn>;

function googleSession() {
  return {
    user: {
      id: 'u1',
      email: 'jane@example.com',
      app_metadata: { provider: 'google' },
    },
  };
}

describe('auth-callback page — Google sign_up wiring', () => {
  let hrefSpy: ReturnType<typeof vi.fn>;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    hrefSpy = vi.fn();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...window.location,
        hash: '',
        search: '',
        set href(v: string) {
          hrefSpy(v);
        },
      },
    });
  });

  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  });

  it('awaits maybeFireGoogleSignUp with the cs_signup referral_source exactly once before redirecting', async () => {
    let resolveGuard: (v: boolean) => void = () => {};
    (maybeFireGoogleSignUp as unknown as Fn).mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveGuard = resolve;
      }),
    );

    let capturedCallback: ((event: string, session: unknown) => void) | undefined;
    (supabase.auth.onAuthStateChange as unknown as Fn).mockImplementation((cb) => {
      capturedCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    render(<AuthCallbackPage />);
    await waitFor(() => expect(capturedCallback).toBeDefined());

    capturedCallback?.('SIGNED_IN', googleSession());

    // maybeFireGoogleSignUp was called with the referral_source from cs_signup...
    await waitFor(() =>
      expect(maybeFireGoogleSignUp as unknown as Fn).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'u1' }),
        'realtor',
      ),
    );
    expect(maybeFireGoogleSignUp as unknown as Fn).toHaveBeenCalledTimes(1);

    // ...and the redirect has NOT happened yet — it is awaited behind the guard.
    expect(hrefSpy).not.toHaveBeenCalled();

    resolveGuard(true);

    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/trade-selector'));
    // Still exactly once — resolving the guard must not cause a second call.
    expect(maybeFireGoogleSignUp as unknown as Fn).toHaveBeenCalledTimes(1);
  });

  it('does not double-invoke the guard across SIGNED_IN + INITIAL_SESSION for the same session', async () => {
    (maybeFireGoogleSignUp as unknown as Fn).mockResolvedValue(true);

    let capturedCallback: ((event: string, session: unknown) => void) | undefined;
    (supabase.auth.onAuthStateChange as unknown as Fn).mockImplementation((cb) => {
      capturedCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    render(<AuthCallbackPage />);
    await waitFor(() => expect(capturedCallback).toBeDefined());

    const session = googleSession();
    capturedCallback?.('SIGNED_IN', session);
    capturedCallback?.('INITIAL_SESSION', session);

    await waitFor(() => expect(hrefSpy).toHaveBeenCalled());
    expect(maybeFireGoogleSignUp as unknown as Fn).toHaveBeenCalledTimes(1);
  });
});

describe('auth-callback page — gh-2121/M2: password-path lead link lands here, not get-started', () => {
  // PR #2163 REVIEW: FAIL fix (comment 5822978578, M2): get-started skips
  // its own in-page linkPendingLeadOnce() call whenever signUp() already
  // returned a live session (auto-confirm, production's default), because
  // the navigation to this page used to cancel that in-flight call. This
  // is the "still links" half of that negative control — the capture
  // (written to sessionStorage the same way for every Arm F path, per
  // lib/lead-capture.ts) survives the navigation and gets linked here,
  // with nothing racing it, on the very next page load.
  let hrefSpy: ReturnType<typeof vi.fn>;
  let originalLocation: PropertyDescriptor | undefined;

  function passwordSession() {
    return {
      user: {
        id: 'u1',
        email: 'jane@example.com',
        app_metadata: { provider: 'email' },
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    (maybeFireGoogleSignUp as unknown as Fn).mockResolvedValue(true);
    hrefSpy = vi.fn();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hash: '', search: '', set href(v: string) { hrefSpy(v); } },
    });
  });

  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
    sessionStorage.clear();
  });

  it('links the sessionStorage-captured lead (navigation-cancelled call at get-started notwithstanding) once a session lands here', async () => {
    sessionStorage.setItem(
      LEAD_STORAGE_KEY,
      JSON.stringify({ id: 'lead-from-get-started', exp: Date.now() + LEAD_TTL_MS }),
    );

    let capturedCallback: ((event: string, session: unknown) => void) | undefined;
    (supabase.auth.onAuthStateChange as unknown as Fn).mockImplementation((cb) => {
      capturedCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    render(<AuthCallbackPage />);
    await waitFor(() => expect(capturedCallback).toBeDefined());

    capturedCallback?.('SIGNED_IN', passwordSession());

    await waitFor(() =>
      expect(supabase.rpc as unknown as Fn).toHaveBeenCalledWith('set_lead_converted', {
        p_lead_id: 'lead-from-get-started',
      }),
    );
    // Consumed: the capture is gone once the RPC has resolved, matching
    // lib/lead-capture.ts's own "clear only on a definitive answer" test.
    await waitFor(() => expect(sessionStorage.getItem(LEAD_STORAGE_KEY)).toBeNull());
  });

  it('negative control: no captured lead in sessionStorage -> set_lead_converted is never called', async () => {
    let capturedCallback: ((event: string, session: unknown) => void) | undefined;
    (supabase.auth.onAuthStateChange as unknown as Fn).mockImplementation((cb) => {
      capturedCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    render(<AuthCallbackPage />);
    await waitFor(() => expect(capturedCallback).toBeDefined());

    capturedCallback?.('SIGNED_IN', passwordSession());

    await waitFor(() => expect(hrefSpy).toHaveBeenCalled());
    expect(supabase.rpc as unknown as Fn).not.toHaveBeenCalledWith(
      'set_lead_converted',
      expect.anything(),
    );
  });
});

describe('auth-callback page — gh-2121/M3: slow link call is not cancelled by navigation', () => {
  // PR #2163 REVIEW: FAIL (M3, comment 5823511418): linkPendingLeadOnce()
  // used to be fire-and-forget here, started and then immediately raced by
  // window.location.href once role resolution finished. This proves the
  // fix: a link RPC slower than the rest of the page (1.5s, per the M3
  // ask) is awaited to completion (in parallel with recordFirstTouch)
  // BEFORE the redirect fires, so the lead ends up linked, not lost.
  let hrefSpy: ReturnType<typeof vi.fn>;
  let originalLocation: PropertyDescriptor | undefined;

  function passwordSession() {
    return {
      user: { id: 'u1', email: 'jane@example.com', app_metadata: { provider: 'email' } },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    (maybeFireGoogleSignUp as unknown as Fn).mockResolvedValue(true);
    hrefSpy = vi.fn();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hash: '', search: '', set href(v: string) { hrefSpy(v); } },
    });
  });

  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
    sessionStorage.clear();
    // vi.clearAllMocks() (run in the next test's beforeEach) resets calls
    // but NOT an implementation installed via mockImplementation — restore
    // the fast default here so later describe blocks in this file (which
    // also exercise supabase.rpc via recordFirstTouch) are not left waiting
    // on this test's 1.5s delay.
    (supabase.rpc as unknown as Fn).mockImplementation(() =>
      Promise.resolve({ data: true, error: null, status: 200 }),
    );
  });

  it(
    'a 1.5s link RPC is awaited to completion before the redirect fires, and the lead ends up linked',
    async () => {
      sessionStorage.setItem(
        LEAD_STORAGE_KEY,
        JSON.stringify({ id: 'lead-slow', exp: Date.now() + LEAD_TTL_MS }),
      );

      (supabase.rpc as unknown as Fn).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ data: true, error: null, status: 200 }), 1500);
          }),
      );

      let capturedCallback: ((event: string, session: unknown) => void) | undefined;
      (supabase.auth.onAuthStateChange as unknown as Fn).mockImplementation((cb) => {
        capturedCallback = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      });

      render(<AuthCallbackPage />);
      await waitFor(() => expect(capturedCallback).toBeDefined());

      capturedCallback?.('SIGNED_IN', passwordSession());

      // The redirect must not fire before the 1.5s RPC has had a real
      // chance to settle -- proves the navigation is not racing/cancelling
      // the call the way it did pre-M3.
      await new Promise((r) => setTimeout(r, 300));
      expect(hrefSpy).not.toHaveBeenCalled();

      await waitFor(() => expect(hrefSpy).toHaveBeenCalled(), { timeout: 3000 });
      expect(supabase.rpc as unknown as Fn).toHaveBeenCalledWith('set_lead_converted', {
        p_lead_id: 'lead-slow',
      });
      // Linked, not lost: the capture is consumed because a definitive
      // (200) answer did arrive within linkPendingLeadOnce's bound.
      expect(sessionStorage.getItem(LEAD_STORAGE_KEY)).toBeNull();
    },
    8000,
  );
});

describe('auth-callback page — gh-1901 Option 2: Google name backfill', () => {
  let hrefSpy: ReturnType<typeof vi.fn>;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (maybeFireGoogleSignUp as unknown as Fn).mockResolvedValue(true);
    hrefSpy = vi.fn();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hash: '', search: '', set href(v: string) { hrefSpy(v); } },
    });
  });

  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
    localStorage.clear();
  });

  function sessionWithGoogleIdentity(userMetadata: Record<string, unknown>) {
    return {
      user: {
        id: 'u1',
        email: 'jane@example.com',
        app_metadata: { provider: 'google' },
        user_metadata: userMetadata,
      },
    };
  }

  async function fireAndWaitForRedirect(session: unknown) {
    let capturedCallback: ((event: string, session: unknown) => void) | undefined;
    (supabase.auth.onAuthStateChange as unknown as Fn).mockImplementation((cb) => {
      capturedCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    render(<AuthCallbackPage />);
    await waitFor(() => expect(capturedCallback).toBeDefined());
    capturedCallback?.('SIGNED_IN', session);
    await waitFor(() => expect(hrefSpy).toHaveBeenCalled());
  }

  it('fills blank cs_signup first/last name from given_name/family_name and forwards them to HubSpot', async () => {
    localStorage.setItem('cs_signup', JSON.stringify({ first_name: '', last_name: '', role: 'homeowner' }));

    await fireAndWaitForRedirect(
      sessionWithGoogleIdentity({ given_name: 'Jane', family_name: 'Doe' }),
    );

    const csSignup = JSON.parse(localStorage.getItem('cs_signup') || '{}');
    expect(csSignup.first_name).toBe('Jane');
    expect(csSignup.last_name).toBe('Doe');

    expect(supabase.functions.invoke as unknown as Fn).toHaveBeenCalledWith(
      'create-hubspot-contact',
      { body: expect.objectContaining({ firstname: 'Jane', lastname: 'Doe' }) },
    );
  });

  it('falls back to splitting full_name when given_name/family_name are absent', async () => {
    localStorage.setItem('cs_signup', JSON.stringify({ first_name: '', last_name: '', role: 'homeowner' }));

    await fireAndWaitForRedirect(sessionWithGoogleIdentity({ full_name: 'Jane Q Doe' }));

    const csSignup = JSON.parse(localStorage.getItem('cs_signup') || '{}');
    expect(csSignup.first_name).toBe('Jane');
    expect(csSignup.last_name).toBe('Q Doe');
  });

  it('never overwrites a name half the visitor already typed', async () => {
    localStorage.setItem(
      'cs_signup',
      JSON.stringify({ first_name: 'Typed', last_name: 'Name', role: 'homeowner' }),
    );

    await fireAndWaitForRedirect(
      sessionWithGoogleIdentity({ given_name: 'Jane', family_name: 'Doe' }),
    );

    const csSignup = JSON.parse(localStorage.getItem('cs_signup') || '{}');
    expect(csSignup.first_name).toBe('Typed');
    expect(csSignup.last_name).toBe('Name');
  });

  it('is a no-op when cs_signup is absent, same as before this change', async () => {
    // No localStorage.setItem — cs_signup is absent.
    await fireAndWaitForRedirect(
      sessionWithGoogleIdentity({ given_name: 'Jane', family_name: 'Doe' }),
    );
    expect(localStorage.getItem('cs_signup')).toBeNull();
  });
});
