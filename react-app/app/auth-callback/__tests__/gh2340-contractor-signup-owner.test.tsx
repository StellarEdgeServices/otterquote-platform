/**
 * gh-2340 -- React auth-callback: a `cs_contractor_signup` blob left by ANOTHER
 * person must be cleared on a homeowner sign-in; the signer's own fresh blob
 * must survive (the pre-approval wizard consumes it). Also asserts the page
 * never writes profiles.role or inserts a contractors row from the blob.
 *
 * NEGATIVE CONTROL: revert the `readOwnedContractorSignup(...)` call in
 * ../page.tsx and the foreign-blob case below fails (blob still present).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { seedStaleStorage } from '@/test/storage-fixtures';

const writes = { profileUpdate: 0, contractorInsert: 0 };

vi.mock('@/lib/supabase', () => {
  const chain = (result: { data: unknown; error: unknown }, table: string) => {
    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.limit = vi.fn(() => b);
    b.update = vi.fn(() => { if (table === 'profiles') writes.profileUpdate += 1; return b; });
    b.insert = vi.fn(() => { if (table === 'contractors') writes.contractorInsert += 1; return b; });
    b.maybeSingle = vi.fn(() => Promise.resolve(result));
    return b;
  };
  return {
    supabase: {
      auth: { onAuthStateChange: vi.fn() },
      rpc: vi.fn(() => Promise.resolve({ data: true, error: null, status: 200 })),
      from: vi.fn((table: string) =>
        table === 'resolved_user_role'
          ? chain({ data: { derived_role: 'homeowner' }, error: null }, table)
          : chain({ data: null, error: null }, table)),
      functions: { invoke: vi.fn(() => Promise.resolve({ error: null })) },
    },
  };
});
vi.mock('@/lib/cookie-storage', () => ({ readReferralIds: vi.fn(() => ({})), writeReferralIds: vi.fn() }));
vi.mock('../signup-analytics', () => ({
  maybeFireGoogleSignUp: vi.fn().mockResolvedValue(true),
  readReferralSourceFromCsSignup: vi.fn(() => null),
}));

import { supabase } from '@/lib/supabase';
import AuthCallbackPage from '../page';

type Fn = ReturnType<typeof vi.fn>;

const blob = (email: string, at?: number) =>
  JSON.stringify({
    email,
    company_name: 'Stranger Roofing',
    contact_name: 'Sam Stranger',
    phone: '555-0100',
    ...(at === undefined ? {} : { _at: at }),
  });

async function signInAsHomeowner() {
  let cb: ((event: string, session: unknown) => void) | undefined;
  (supabase.auth.onAuthStateChange as unknown as Fn).mockImplementation((f) => {
    cb = f;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  render(<AuthCallbackPage />);
  await waitFor(() => expect(cb).toBeDefined());
  cb?.('SIGNED_IN', { user: { id: 'u-home', email: 'homeowner@example.com', app_metadata: { provider: 'email' } } });
}

describe('auth-callback -- cs_contractor_signup owner guard (gh-2340)', () => {
  let hrefSpy: ReturnType<typeof vi.fn>;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    writes.profileUpdate = 0;
    writes.contractorInsert = 0;
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

  it('a FOREIGN blob (different email, fresh stamp) is cleared, with no role write and no contractors insert', async () => {
    seedStaleStorage({ localStorage: { cs_contractor_signup: blob('stranger@example.com', Date.now()) } });
    await signInAsHomeowner();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalled());
    expect(localStorage.getItem('cs_contractor_signup')).toBeNull();
    expect(writes).toEqual({ profileUpdate: 0, contractorInsert: 0 });
  });

  it('a STALE (>24h) blob for the same email is cleared', async () => {
    seedStaleStorage({ localStorage: { cs_contractor_signup: blob('homeowner@example.com', Date.now() - 25 * 3600 * 1000) } });
    await signInAsHomeowner();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalled());
    expect(localStorage.getItem('cs_contractor_signup')).toBeNull();
  });

  it('a FUTURE-dated stamp is cleared', async () => {
    seedStaleStorage({ localStorage: { cs_contractor_signup: blob('homeowner@example.com', Date.now() + 3600 * 1000) } });
    await signInAsHomeowner();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalled());
    expect(localStorage.getItem('cs_contractor_signup')).toBeNull();
  });

  it('POSITIVE CONTROL: the signer own fresh blob (email match, case/space-insensitive) is left for the wizard', async () => {
    seedStaleStorage({ localStorage: { cs_contractor_signup: blob('  Homeowner@Example.com ', Date.now() - 60 * 1000) } });
    await signInAsHomeowner();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalled());
    expect(localStorage.getItem('cs_contractor_signup')).not.toBeNull();
  });
});
