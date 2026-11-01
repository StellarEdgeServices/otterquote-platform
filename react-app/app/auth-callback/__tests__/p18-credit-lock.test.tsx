/**
 * P18 (#3219) - React auth-callback and the partner credit lock.
 * After advance_referral_registered, the page asks get_locked_referral_id(). If the database says a DIFFERENT referral is locked to
 * this user (they signed up through A, then clicked B), the cookie goes back to A. Server stamping is the authority; this keeps the
 * browser from carrying a stranger's id.
 *
 * Real `@/lib/cookie-storage` (real jsdom cookie jar); only supabase and the analytics helper are mocked.
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
const CLAIM = 'oq_referral_id_for_claim';
const A = { oq_referral_id: 'ref-A', oq_referral_agent_id: 'agent-A', oq_referral_code: 'PARTNERA' };
const B = { oq_referral_id: 'ref-B', oq_referral_agent_id: 'agent-B', oq_referral_code: 'PARTNERB' };

function clearAllCookies() {
  document.cookie.split('; ').forEach((c) => {
    const key = c.split('=')[0];
    if (key) document.cookie = `${key}=; Path=/; Max-Age=0`;
  });
}
const calls = (name: string) => (supabase.rpc as unknown as Fn).mock.calls.filter((c) => c[0] === name);

/** advance_referral_registered answers `advance`; get_locked_referral_id answers `locked`. */
function mockRpc(advance: unknown, locked: unknown, lockedError: unknown = null) {
  (supabase.rpc as unknown as Fn).mockImplementation((name: string) =>
    Promise.resolve(
      name === 'get_locked_referral_id'
        ? { data: locked, error: lockedError, status: 200 }
        : { data: advance, error: null, status: 200 }
    )
  );
}

async function signIn() {
  let cb: ((event: string, session: unknown) => void) | undefined;
  (supabase.auth.onAuthStateChange as unknown as Fn).mockImplementation((fn) => {
    cb = fn;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  render(<AuthCallbackPage />);
  await waitFor(() => expect(cb).toBeDefined());
  cb?.('SIGNED_IN', { user: { id: 'u1', email: 'jane@example.com', app_metadata: { provider: 'email' } } });
  await waitFor(() => expect((supabase.rpc as unknown as Fn).mock.calls.length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 50));
}

describe('P18: auth-callback keeps the locked partner, not the latest click', () => {
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
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

  it('A locked, cookie holds B: B is offered to the advance RPC, then the cookie and claim key go back to A', async () => {
    mockRpc(false, 'ref-A'); // advance(B) is refused: the user's credit is already locked to A
    writeReferralIds(B, { click: true });
    await signIn();
    expect(calls('advance_referral_registered')).toEqual([['advance_referral_registered', { p_referral_id: 'ref-B' }]]);
    expect(calls('get_locked_referral_id').length).toBe(1);
    const ids = readReferralIds();
    expect(ids.oq_referral_id).toBe('ref-A');
    expect(ids.oq_referral_agent_id).toBeUndefined();
    expect(ids[CLAIM]).toBe('ref-A');
  });

  it('first sign-up through B (B just locked): the cookie is unchanged, agent and code kept (control)', async () => {
    mockRpc(true, 'ref-B');
    writeReferralIds(B, { click: true });
    await signIn();
    const ids = readReferralIds();
    expect(ids.oq_referral_id).toBe('ref-B');
    expect(ids.oq_referral_agent_id).toBe('agent-B');
    expect(ids[CLAIM]).toBe('ref-B');
  });

  it('no locked referral (null): the cookie is unchanged (control)', async () => {
    mockRpc(false, null);
    writeReferralIds(A, { click: true });
    await signIn();
    expect(readReferralIds().oq_referral_id).toBe('ref-A');
  });

  it('get_locked_referral_id errors: sign-in is not blocked and the cookie is unchanged', async () => {
    mockRpc(true, null, { message: 'boom' });
    writeReferralIds(A, { click: true });
    await signIn();
    expect(readReferralIds().oq_referral_id).toBe('ref-A');
    expect(readReferralIds().oq_referral_agent_id).toBe('agent-A');
  });

  it('no referral on this browser: neither RPC is called', async () => {
    mockRpc(true, 'ref-A');
    await signIn();
    expect(calls('advance_referral_registered')).toEqual([]);
    expect(calls('get_locked_referral_id')).toEqual([]);
  });

  it('a click 91 days old is not offered and not swapped (negative control for the 90-day window)', async () => {
    mockRpc(true, 'ref-A');
    writeReferralIds(B, { click: true });
    vi.setSystemTime(Date.now() + 91 * 24 * 3600 * 1000);
    await signIn();
    expect(calls('advance_referral_registered')).toEqual([]);
    expect(calls('get_locked_referral_id')).toEqual([]);
    expect(readReferralIds()).toEqual({});
  });
});
