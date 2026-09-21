/**
 * gh-2051: hardening for the referral-advance failure path.
 *
 * advance_referral_registered() returns FOUND (a boolean): true when it
 * actually flipped a 'clicked' row to 'registered', false when the row
 * didn't exist or was already past 'clicked' (a definitive, non-retryable
 * no-op). Supabase-js *returns* `{ error }` on an RPC failure rather than
 * throwing, so the surrounding try/catch does not protect the lines after
 * the call — the old code unconditionally cleared oq_referral_id /
 * sessionStorage's copy even when advanceError was truthy, permanently
 * dropping attribution on a transient failure with no way to retry.
 *
 * These tests assert the fix: the advance-scoped keys survive an RPC error
 * (so a later load can retry) but are still cleared on success — and, as a
 * negative control, a page load with no referral click never creates or
 * touches any of these keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

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
      rpc: vi.fn(() => Promise.resolve({ data: true, error: null })),
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
  maybeFireGoogleSignUp: vi.fn(() => Promise.resolve(true)),
  readReferralSourceFromCsSignup: vi.fn(() => null),
}));

import { supabase } from '@/lib/supabase';
import AuthCallbackPage from '../page';

type Fn = ReturnType<typeof vi.fn>;

function session() {
  return {
    user: {
      id: 'u1',
      email: 'jane@example.com',
      app_metadata: { provider: 'email' },
    },
  };
}

async function mountAndSignIn() {
  let capturedCallback: ((event: string, session: unknown) => void) | undefined;
  (supabase.auth.onAuthStateChange as unknown as Fn).mockImplementation((cb) => {
    capturedCallback = cb;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });

  render(<AuthCallbackPage />);
  await waitFor(() => expect(capturedCallback).toBeDefined());
  capturedCallback?.('SIGNED_IN', session());
}

describe('auth-callback page — referral advance failure path (gh-2051)', () => {
  let hrefSpy: Fn;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
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
    localStorage.clear();
    sessionStorage.clear();
  });

  it('preserves oq_referral_id (and still writes the claim-scoped key) when the RPC returns an error', async () => {
    localStorage.setItem('oq_referral_id', 'ref-123');
    sessionStorage.setItem('oq_referral_id', 'ref-123');
    (supabase.rpc as unknown as Fn).mockResolvedValue({
      data: null,
      error: { message: 'network error' },
    });

    await mountAndSignIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/trade-selector'));

    expect(supabase.rpc).toHaveBeenCalledWith('advance_referral_registered', {
      p_referral_id: 'ref-123',
    });
    // The defect under fix: these must SURVIVE an RPC error so a later page
    // load can retry the advance instead of dropping attribution forever.
    expect(localStorage.getItem('oq_referral_id')).toBe('ref-123');
    expect(sessionStorage.getItem('oq_referral_id')).toBe('ref-123');
    // Claim linkage is a separate concern — written even though the advance failed.
    expect(localStorage.getItem('oq_referral_id_for_claim')).toBe('ref-123');
  });

  it('negative control: on a successful advance, oq_referral_id is still cleared exactly as before', async () => {
    localStorage.setItem('oq_referral_id', 'ref-456');
    sessionStorage.setItem('oq_referral_id', 'ref-456');
    (supabase.rpc as unknown as Fn).mockResolvedValue({ data: true, error: null });

    await mountAndSignIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/trade-selector'));

    expect(localStorage.getItem('oq_referral_id')).toBeNull();
    expect(sessionStorage.getItem('oq_referral_id')).toBeNull();
    expect(localStorage.getItem('oq_referral_id_for_claim')).toBe('ref-456');
  });

  it('a confirmed no-op (advanced === false, no error) is treated as terminal and still clears the keys', async () => {
    localStorage.setItem('oq_referral_id', 'ref-789');
    sessionStorage.setItem('oq_referral_id', 'ref-789');
    (supabase.rpc as unknown as Fn).mockResolvedValue({ data: false, error: null });

    await mountAndSignIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/trade-selector'));

    // false-with-no-error means "already registered / doesn't exist" — retrying
    // can never succeed, so this is NOT preserved the way an error is.
    expect(localStorage.getItem('oq_referral_id')).toBeNull();
    expect(sessionStorage.getItem('oq_referral_id')).toBeNull();
  });

  it('negative control: with no referral click, the RPC is never called and no referral keys appear', async () => {
    // oq_referral_id deliberately left unset.
    await mountAndSignIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/trade-selector'));

    // supabase.rpc is also used for unrelated first-touch attribution
    // (record_first_touch_attribution) — assert specifically that the
    // referral-advance RPC was never invoked, not that rpc was untouched.
    expect(supabase.rpc as unknown as Fn).not.toHaveBeenCalledWith(
      'advance_referral_registered',
      expect.anything(),
    );
    expect(localStorage.getItem('oq_referral_id')).toBeNull();
    expect(localStorage.getItem('oq_referral_id_for_claim')).toBeNull();
    expect(sessionStorage.getItem('oq_referral_id')).toBeNull();
  });

  it('PR review finding 2 — a preserved key older than the 24h retry TTL is ignored and removed, never retried', async () => {
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    localStorage.setItem('oq_referral_id', 'ref-stale');
    localStorage.setItem('oq_referral_id_saved_at', String(twentyFiveHoursAgo));
    sessionStorage.setItem('oq_referral_id', 'ref-stale');

    await mountAndSignIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/trade-selector'));

    // A retry that hasn't happened within a day never will — the stale id
    // must never even reach the RPC (an assertion on RPC args, not just
    // "rpc was called", since the RPC is also used for unrelated first-touch
    // attribution).
    expect(supabase.rpc as unknown as Fn).not.toHaveBeenCalledWith(
      'advance_referral_registered',
      expect.anything(),
    );
    expect(localStorage.getItem('oq_referral_id')).toBeNull();
    expect(localStorage.getItem('oq_referral_id_saved_at')).toBeNull();
    expect(sessionStorage.getItem('oq_referral_id')).toBeNull();
  });

  it('PR review finding 2 — a freshly-failed advance stamps the retry clock and the id is still honoured (not wiped)', async () => {
    localStorage.setItem('oq_referral_id', 'ref-fresh');
    sessionStorage.setItem('oq_referral_id', 'ref-fresh');
    // No pre-existing oq_referral_id_saved_at — this simulates the FIRST failure.
    (supabase.rpc as unknown as Fn).mockResolvedValue({
      data: null,
      error: { message: 'network error' },
    });

    const before = Date.now();
    await mountAndSignIn();
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('/trade-selector'));

    // Still attempted — a brand-new failure must not be treated as stale.
    expect(supabase.rpc).toHaveBeenCalledWith('advance_referral_registered', {
      p_referral_id: 'ref-fresh',
    });
    // The retry clock starts now — this is the behavior finding 2 requires
    // and the pre-fix code never wrote this key at all.
    const savedAt = Number(localStorage.getItem('oq_referral_id_saved_at'));
    expect(Number.isFinite(savedAt)).toBe(true);
    expect(savedAt).toBeGreaterThanOrEqual(before);
    expect(savedAt).toBeLessThanOrEqual(Date.now());
    // The id itself is still honoured (preserved for retry), unaffected by
    // adding the TTL stamp.
    expect(localStorage.getItem('oq_referral_id')).toBe('ref-fresh');
    expect(sessionStorage.getItem('oq_referral_id')).toBe('ref-fresh');
  });
});
