/**
 * gh-2344 -- React stack: the `cs_auth_role` breadcrumb is bound to its signer.
 *
 * The 24h TTL bounds the breadcrumb's AGE, not who it is for: on a shared
 * device a stranger's abandoned `cs_auth_role='contractor'` steered the NEXT
 * person's post-login routing into the contractor wizard. The writer now stores
 * the signer's normalised email in `cs_auth_role_email`; this page honours the
 * breadcrumb only when that equals the signed-in user's email (or, for a Google
 * OAuth write that could not know the email, this tab's nonce). Foreign or
 * owner-less (legacy) breadcrumbs are ignored AND all keys are cleared.
 *
 * NEGATIVE CONTROL: the foreign/legacy/other-tab cases FAIL on origin/main's
 * auth-callback/page.tsx (the foreign breadcrumb steers routing to the wizard);
 * the same-signer cases pass on both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { seedStaleStorage } from '@/test/storage-fixtures';

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
        if (table === 'resolved_user_role') return chain({ data: { derived_role: 'homeowner' }, error: null });
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

const ME = 'jane@example.com';
const STRANGER = 'stranger@example.com';

function session() {
  return { user: { id: 'u1', email: ME, app_metadata: { provider: 'email' } } };
}

async function signIn() {
  let cb: ((event: string, s: unknown) => void) | undefined;
  (supabase.auth.onAuthStateChange as unknown as Fn).mockImplementation((f) => {
    cb = f;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  render(<AuthCallbackPage />);
  await waitFor(() => expect(cb).toBeDefined());
  cb?.('SIGNED_IN', session());
}

function expectAllKeysCleared() {
  expect(localStorage.getItem('cs_auth_role')).toBeNull();
  expect(localStorage.getItem('cs_auth_role_at')).toBeNull();
  expect(localStorage.getItem('cs_auth_role_email')).toBeNull();
  expect(sessionStorage.getItem('cs_auth_role_tab')).toBeNull();
}

describe('auth-callback page -- gh-2344 cs_auth_role owner binding', () => {
  let hrefSpy: ReturnType<typeof vi.fn>;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('foreign-email cs_auth_role=contractor is ignored and cleared: a fresh (<24h) breadcrumb written for a different email does not steer this sign-in into the contractor wizard', async () => {
    seedStaleStorage({
      localStorage: {
        cs_auth_role: 'contractor',
        cs_auth_role_email: STRANGER,
        cs_auth_role_at: String(Date.now() - 5 * 60 * 1000),
      },
    });
    await signIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalled());
    expect(hrefSpy).not.toHaveBeenCalledWith(expect.stringContaining('contractor-pre-approval'));
    expectAllKeysCleared();
  });

  it('legacy owner-less cs_auth_role=contractor (fresh stamp, no cs_auth_role_email) is treated as foreign: ignored and cleared', async () => {
    seedStaleStorage({
      localStorage: { cs_auth_role: 'contractor', cs_auth_role_at: String(Date.now() - 5 * 60 * 1000) },
    });
    await signIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalled());
    expect(hrefSpy).not.toHaveBeenCalledWith(expect.stringContaining('contractor-pre-approval'));
    expectAllKeysCleared();
  });

  it('POSITIVE CONTROL: a same-email cs_auth_role=contractor (case/space-insensitive) still routes to the contractor wizard and is consumed', async () => {
    seedStaleStorage({
      localStorage: {
        cs_auth_role: 'contractor',
        cs_auth_role_email: '  Jane@Example.COM ',
        cs_auth_role_at: String(Date.now() - 5 * 60 * 1000),
      },
    });
    await signIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith(expect.stringContaining('contractor-pre-approval')));
    expectAllKeysCleared();
  });

  it('a same-email breadcrumb older than 24h is still ignored (TTL kept)', async () => {
    seedStaleStorage({
      localStorage: {
        cs_auth_role: 'contractor',
        cs_auth_role_email: ME,
        cs_auth_role_at: String(Date.now() - 25 * 60 * 60 * 1000),
      },
    });
    await signIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalled());
    expect(hrefSpy).not.toHaveBeenCalledWith(expect.stringContaining('contractor-pre-approval'));
    expectAllKeysCleared();
  });

  it('Google OAuth breadcrumb (email unknown at write time) is honoured only in the tab that wrote it', async () => {
    // Same tab: nonce in sessionStorage matches -> honoured.
    seedStaleStorage({
      localStorage: {
        cs_auth_role: 'contractor',
        cs_auth_role_email: 'oauth-tab:n0nce',
        cs_auth_role_at: String(Date.now() - 60 * 1000),
      },
      sessionStorage: { cs_auth_role_tab: 'n0nce' },
    });
    await signIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith(expect.stringContaining('contractor-pre-approval')));
    expectAllKeysCleared();
  });

  it('a stranger\'s OAuth-tab breadcrumb (no matching nonce in this tab) is ignored and cleared', async () => {
    seedStaleStorage({
      localStorage: {
        cs_auth_role: 'contractor',
        cs_auth_role_email: 'oauth-tab:n0nce',
        cs_auth_role_at: String(Date.now() - 60 * 1000),
      },
    });
    await signIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalled());
    expect(hrefSpy).not.toHaveBeenCalledWith(expect.stringContaining('contractor-pre-approval'));
    expectAllKeysCleared();
  });
});
