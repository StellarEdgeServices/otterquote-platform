/**
 * gh-2062 (REVIEW: FAIL 5881363760 / RETURNED 5881780522) - React auth-callback.
 *
 * Must-fix 1: `oq_referral_id_for_claim` rides the same 30-day click clock as
 * the `oq-ref` cookie. Advance at day 0 with no claim; nothing attributes at
 * day 31 (positive control: day 29 still does).
 * Must-fix 2: auth-callback calls the windowed reader FIRST, so an expired or
 * undated app-origin mirror neither advances nor sets `_for_claim`.
 *
 * Real `@/lib/cookie-storage` (real jsdom cookie jar); only supabase and the
 * analytics helper are mocked.
 *
 * NEGATIVE CONTROL: at PR head 8a1ab1f1 the day-29/day-31 module checks and the
 * expired/undated-mirror page checks fail (see the PR comment for the output).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

vi.mock('@/lib/supabase', () => {
  const chain = (result: { data: unknown; error: unknown }) => {
    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.limit = vi.fn(() => b);
    b.maybeSingle = vi.fn(() => Promise.resolve(result));
    return b;
  };
  return {
    supabase: {
      auth: { onAuthStateChange: vi.fn() },
      rpc: vi.fn(() => Promise.resolve({ data: true, error: null, status: 200 })),
      from: vi.fn((table: string) =>
        table === 'resolved_user_role'
          ? chain({ data: { derived_role: 'homeowner' }, error: null })
          : chain({ data: null, error: null })),
      functions: { invoke: vi.fn(() => Promise.resolve({ error: null })) },
    },
  };
});
vi.mock('../signup-analytics', () => ({
  maybeFireGoogleSignUp: vi.fn().mockResolvedValue(true),
  readReferralSourceFromCsSignup: vi.fn(() => null),
}));

import { supabase } from '@/lib/supabase';
import { readReferralIds, writeReferralIds, clearReferralIds } from '@/lib/cookie-storage';
import AuthCallbackPage from '../page';

type Fn = ReturnType<typeof vi.fn>;
const DAY_MS = 24 * 3600 * 1000;
const CLAIM = 'oq_referral_id_for_claim';
const A = { oq_referral_id: 'ref-A', oq_referral_agent_id: 'agent-A', oq_referral_code: 'PARTNERA' };

function clearAllCookies() {
  document.cookie.split('; ').forEach((c) => {
    const key = c.split('=')[0];
    if (key) document.cookie = `${key}=; Path=/; Max-Age=0`;
  });
}

const advanceCalls = () =>
  (supabase.rpc as unknown as Fn).mock.calls.filter((c) => c[0] === 'advance_referral_registered');

async function signIn() {
  let cb: ((event: string, session: unknown) => void) | undefined;
  (supabase.auth.onAuthStateChange as unknown as Fn).mockImplementation((fn) => {
    cb = fn;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  render(<AuthCallbackPage />);
  await waitFor(() => expect(cb).toBeDefined());
  cb?.('SIGNED_IN', { user: { id: 'u1', email: 'jane@example.com', app_metadata: { provider: 'email' } } });
  // routeSession finishes by redirecting (or, for a referral, after the RPC).
  await waitFor(() => expect((supabase.rpc as unknown as Fn).mock.calls.length + (supabase.from as unknown as Fn).mock.calls.length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 50));
}

describe('gh-2062: auth-callback referral advance under the 30-day click clock', () => {
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    localStorage.clear();
    sessionStorage.clear();
    clearAllCookies();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hash: '', search: '', hostname: 'localhost', protocol: 'http:', set href(_v: string) { /* swallow redirect */ } },
    });
  });
  afterEach(() => {
    clearReferralIds();
    clearAllCookies();
    vi.useRealTimers();
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  });

  it('day 0: a click-armed id advances and is re-keyed to the claim-scoped key', async () => {
    writeReferralIds(A, { click: true });
    await signIn();
    expect(advanceCalls()).toEqual([['advance_referral_registered', { p_referral_id: 'ref-A' }]]);
    expect(localStorage.getItem(CLAIM)).toBe('ref-A');
  });

  it('POSITIVE CONTROL day 29: the claim-scoped id is still returned by the windowed reader', async () => {
    writeReferralIds(A, { click: true });
    await signIn();
    vi.setSystemTime(Date.now() + 29 * DAY_MS);
    expect(readReferralIds()[CLAIM]).toBe('ref-A');
  });

  it('day 31, no claim filed: the windowed reader returns NO claim-scoped id and purges it', async () => {
    writeReferralIds(A, { click: true });
    await signIn();
    vi.setSystemTime(Date.now() + 31 * DAY_MS);
    const ids = readReferralIds();
    expect(ids[CLAIM]).toBeUndefined();
    expect(ids.oq_referral_id).toBeUndefined();
    expect(localStorage.getItem(CLAIM)).toBeNull();
  });

  it('undated claim-scoped id (no click time on record) is expired by the reader', () => {
    localStorage.setItem(CLAIM, 'ref-stale');
    expect(readReferralIds()[CLAIM]).toBeUndefined();
    expect(localStorage.getItem(CLAIM)).toBeNull();
  });

  it('must-fix 2: an UNDATED app-origin mirror does not advance and does not set _for_claim', async () => {
    localStorage.setItem('oq_referral_id', 'ref-stale');
    await signIn();
    expect(advanceCalls()).toEqual([]);
    expect(localStorage.getItem(CLAIM)).toBeNull();
    expect(localStorage.getItem('oq_referral_id')).toBeNull();
  });

  it('must-fix 2: an EXPIRED app-origin mirror (click 31 days ago) does not advance and does not set _for_claim', async () => {
    localStorage.setItem('oq_referral_id', 'ref-stale');
    sessionStorage.setItem('oq_referral_id', 'ref-stale');
    localStorage.setItem('oq_referral_ts', String(Date.now() - 31 * DAY_MS));
    await signIn();
    expect(advanceCalls()).toEqual([]);
    expect(localStorage.getItem(CLAIM)).toBeNull();
  });
});
