/**
 * gh-3270 -- auth-callback routing for returning homeowners, plus the
 * typed-email vs Google-email notice.
 *
 *   (1) latest claim is an address-less draft  -> /trade-selector (was: dashboard)
 *   (2) latest claim finished intake           -> dashboard (negative control)
 *   (3) no claim                               -> /trade-selector
 *   (4) the claims query selects property_address
 *   (5) Google email differs from cs_signup.email -> notice, Continue routes on
 *   (6) emails match (case/whitespace ignored), blank typed email, or the
 *       password path -> no notice, immediate redirect
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { claimResult, claimsSelectMock } = vi.hoisted(() => ({
  claimResult: { current: { data: null as unknown, error: null as unknown } },
  claimsSelectMock: vi.fn(),
}));

vi.mock('@/lib/supabase', () => {
  const chain = (getResult: () => { data: unknown; error: unknown }, onSelect?: (cols: string) => void) => {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn((cols: string) => {
      onSelect?.(cols);
      return builder;
    });
    builder.eq = vi.fn(() => builder);
    builder.order = vi.fn(() => builder);
    builder.limit = vi.fn(() => builder);
    builder.maybeSingle = vi.fn(() => Promise.resolve(getResult()));
    return builder;
  };
  return {
    supabase: {
      auth: { onAuthStateChange: vi.fn() },
      rpc: vi.fn(() => Promise.resolve({ data: true, error: null, status: 200 })),
      from: vi.fn((table: string) => {
        if (table === 'resolved_user_role') {
          return chain(() => ({ data: { derived_role: 'homeowner' }, error: null }));
        }
        if (table === 'claims') {
          return chain(() => claimResult.current, (cols) => claimsSelectMock(cols));
        }
        return chain(() => ({ data: null, error: null }));
      }),
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
const DASHBOARD = 'https://otterquote.com/dashboard.html';

function session(provider: 'google' | 'email', email = 'dustin@tryotterquote.com') {
  return { user: { id: 'u1', email, app_metadata: { provider }, user_metadata: {} } };
}

function seedSignup(extra: Record<string, unknown> = {}) {
  localStorage.setItem(
    'cs_signup',
    JSON.stringify({ first_name: 'Jane', last_name: 'Doe', phone: '3175551234', ...extra }),
  );
  localStorage.setItem('cs_signup_at', String(Date.now()));
}

describe('auth-callback gh-3270', () => {
  let hrefSpy: Fn;
  let originalLocation: PropertyDescriptor | undefined;
  let fire: ((event: string, s: unknown) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    claimResult.current = { data: null, error: null };
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
    fire = undefined;
    (supabase.auth.onAuthStateChange as unknown as Fn).mockImplementation((cb) => {
      fire = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
  });

  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  });

  async function signIn(s: unknown) {
    render(<AuthCallbackPage />);
    await waitFor(() => expect(fire).toBeDefined());
    fire?.('SIGNED_IN', s);
  }

  it('(1) returning user with an address-less draft claim goes to /trade-selector', async () => {
    claimResult.current = { data: { id: 'draft-1', property_address: null }, error: null };
    await signIn(session('google'));
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/trade-selector'));
    expect(hrefSpy).not.toHaveBeenCalledWith(DASHBOARD);
  });

  it('(1b) a blank-string property_address also counts as unfinished', async () => {
    claimResult.current = { data: { id: 'draft-1', property_address: '   ' }, error: null };
    await signIn(session('email'));
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/trade-selector'));
  });

  it('(2) negative control: a claim that finished intake still goes to the dashboard', async () => {
    claimResult.current = {
      data: { id: 'claim-1', property_address: '910 Congress Street, Noblesville, IN 46060' },
      error: null,
    };
    await signIn(session('google'));
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith(DASHBOARD));
    expect(hrefSpy).not.toHaveBeenCalledWith('/trade-selector');
  });

  it('(3) no claim goes to /trade-selector', async () => {
    await signIn(session('google'));
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/trade-selector'));
  });

  it('(4) the claims lookup selects property_address', async () => {
    await signIn(session('google'));
    await waitFor(() => expect(hrefSpy).toHaveBeenCalled());
    expect(claimsSelectMock).toHaveBeenCalledWith(expect.stringContaining('property_address'));
  });

  it('(5) Google email differs from the typed email: notice shows, no redirect until Continue', async () => {
    seedSignup({ email: 'dustinstohler1@gmail.com' });
    claimResult.current = { data: { id: 'draft-1', property_address: null }, error: null };
    await signIn(session('google', 'dustin@tryotterquote.com'));

    const notice = await screen.findByTestId('email-mismatch-notice');
    expect(notice.textContent).toContain('dustinstohler1@gmail.com');
    expect(notice.textContent).toContain('dustin@tryotterquote.com');
    expect(hrefSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(hrefSpy).toHaveBeenCalledWith('/trade-selector');
  });

  it('(5b) Continue on the notice keeps the dashboard destination for a finished claim', async () => {
    seedSignup({ email: 'other@example.com' });
    claimResult.current = { data: { id: 'c1', property_address: '1 Main St, Zionsville, IN 46077' }, error: null };
    await signIn(session('google', 'dustin@tryotterquote.com'));
    await screen.findByTestId('email-mismatch-notice');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(hrefSpy).toHaveBeenCalledWith(DASHBOARD);
  });

  it('(6a) matching emails (case and whitespace ignored): no notice', async () => {
    seedSignup({ email: '  Dustin@TryOtterQuote.com ' });
    await signIn(session('google', 'dustin@tryotterquote.com'));
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/trade-selector'));
    expect(screen.queryByTestId('email-mismatch-notice')).toBeNull();
  });

  it('(6b) no typed email in cs_signup: no notice', async () => {
    seedSignup({ email: null });
    await signIn(session('google'));
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/trade-selector'));
    expect(screen.queryByTestId('email-mismatch-notice')).toBeNull();
  });

  it('(6c) non-Google sign-in never shows the notice', async () => {
    seedSignup({ email: 'someone-else@example.com' });
    await signIn(session('email', 'dustin@tryotterquote.com'));
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/trade-selector'));
    expect(screen.queryByTestId('email-mismatch-notice')).toBeNull();
  });
});
