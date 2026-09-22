/**
 * gh-2062 — the `oq-ref` cookie is refreshed unconditionally (90-day TTL)
 * and never cleared after a claim, so a stale referral id can misattribute
 * a signup up to 90 days later on a reused browser.
 *
 * This is the money-path acceptance test the issue's closes-on requires:
 * a browser holding a referral id completes a claim, and — after that claim
 * has consumed the id — the same browser's next, unrelated pass must NOT
 * still carry the old attribution. BESIDE that: a browser with a live,
 * not-yet-claimed referral must still attribute correctly, so the fix does
 * not destroy legitimate attribution while closing the leak.
 *
 * Per the issue's own warning (the reason gh-2060 went unseen): this drives
 * the REAL `oq-ref` cookie via the real `@/lib/cookie-storage` module
 * (`readReferralIds`/`writeReferralIds`/`clearReferralIds`), not a mocked
 * `readReferralIds()`. Only `@/lib/supabase` and the auth hook are mocked,
 * matching the existing `gh1993-claims-address-write.test.tsx` harness for
 * this same `handleComplete` claims-insert path.
 *
 * react-app/app/trade-selector/page.tsx is the live production claim
 * writer (the static trade-selector.html twin gets the mirrored fix but is
 * not exercised by this test — see PR body / issue comment for why the
 * React surface is the one this evidence is built against).
 *
 * ROUND 2 (REVIEW: FAIL on PR #2103): round 1's clear() fired whenever a
 * referral was PRESENT, not whenever the claim write that was supposed to
 * record it actually SUCCEEDED. Supabase does not throw on a failed write
 * by default (no throwOnError() anywhere in this repo) — an RLS denial or
 * constraint violation resolves normally as { data: null, error: {...} }.
 * That silently over-cleared a live, unconsumed referral on every failed
 * write, under-paying the partner who earned it. The fourth test below is
 * the one that would have caught it: a claim insert that resolves with
 * `error` set (not a thrown exception) must leave the cookie untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { claimsInsertMock } = vi.hoisted(() => ({
  claimsInsertMock: vi.fn((_payload: Record<string, unknown>) => ({
    select: () => ({
      single: () => Promise.resolve({ data: { id: 'test-claim-id' }, error: null }),
    }),
  })),
}));

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/lib/supabase', () => {
  const claimsSelectChain = {
    select: () => claimsSelectChain,
    eq: () => claimsSelectChain,
    order: () => claimsSelectChain,
    limit: () => claimsSelectChain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  };
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'profiles') {
          return { upsert: vi.fn(() => Promise.resolve({ error: null })) };
        }
        if (table === 'claims') {
          return {
            select: () => claimsSelectChain,
            insert: claimsInsertMock,
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          };
        }
        return { select: () => claimsSelectChain };
      },
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    },
  };
});

import { useAuthReady } from '@/hooks/use-auth-ready';
import { readReferralIds, writeReferralIds } from '@/lib/cookie-storage';
import TradeSelectorPage from '../page';

type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) => (useAuthReady as unknown as AuthVal).mockReturnValue(v);

const CS_SIGNUP = {
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '3175551234',
  address: '910 Congress Street, Noblesville, IN 46060',
  address_street: '910 Congress Street',
  address_city: 'Noblesville',
  address_state: 'IN',
  address_zip: '46060',
};

const PARTNER_A_REFERRAL = {
  oq_referral_id: 'referral-aaa-111',
  oq_referral_agent_id: 'agent-aaa-111',
  oq_referral_code: 'PARTNERA',
};

function clearAllCookies() {
  // jsdom exposes document.cookie as a plain settable string; deleting one
  // key at a time (as clearReferralIds does) is exercised for real by the
  // code under test, but between tests we want a clean slate regardless of
  // what a prior test left behind.
  document.cookie.split('; ').forEach((c) => {
    const key = c.split('=')[0];
    if (key) document.cookie = `${key}=; Path=/; Max-Age=0`;
  });
}

describe('TradeSelectorPage referral cookie — gh-2062 (money-path: both directions)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    clearAllCookies();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      // hostname/protocol are required here (unlike the gh1993 harness this
      // is otherwise copied from): getCookieDomain() in cookie-storage.ts
      // reads window.location.hostname/protocol, and writeReferralIds()
      // silently swallows a cookie-write failure (try/catch, "cookie
      // blocked"). Without these, the real oq-ref cookie is NEVER actually
      // written and every document.cookie assertion in this file passes or
      // fails for the wrong reason — the storage-fallback in
      // readReferralIds() was masking it. Matches jsdom's real default
      // test origin (http://localhost/).
      value: { href: '', search: '', hostname: 'localhost', protocol: 'http:' },
    });
    mockAuth({ user: { id: 'u1', email: 'jane@example.com' }, loading: false, settled: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function completeCashSingleTradeWalk() {
    localStorage.setItem('cs_signup', JSON.stringify(CS_SIGNUP));
    render(<TradeSelectorPage />);

    fireEvent.click(screen.getByText("I'm paying for this myself (retail/cash)"));
    await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Roofing'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('Repair or Replace?')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(claimsInsertMock).toHaveBeenCalledTimes(1));
    return claimsInsertMock.mock.calls[0][0] as Record<string, unknown>;
  }

  it('POSITIVE CONTROL: a live, unconsumed referral still attributes correctly', async () => {
    writeReferralIds(PARTNER_A_REFERRAL);

    const payload = await completeCashSingleTradeWalk();

    expect(payload.referral_id).toBe(PARTNER_A_REFERRAL.oq_referral_id);
    expect(payload.referral_agent_id).toBe(PARTNER_A_REFERRAL.oq_referral_agent_id);
    expect(payload.referral_code).toBe(PARTNER_A_REFERRAL.oq_referral_code);
  });

  it('gh-2062 FIX: a CONSUMED referral is cleared and does not resurface', async () => {
    writeReferralIds(PARTNER_A_REFERRAL);

    const payload = await completeCashSingleTradeWalk();
    // Sanity: this pass did attribute to partner A (same assertion as the
    // positive control above) — the claim genuinely consumed the referral.
    expect(payload.referral_id).toBe(PARTNER_A_REFERRAL.oq_referral_id);

    // The defect: previously the cookie (and its localStorage/sessionStorage
    // mirrors) survived this claim untouched, at its full 90-day TTL, ready
    // to reattribute the NEXT signup on this browser to partner A even
    // though partner A's referral has already been paid out via this claim.
    const afterClaim = readReferralIds();
    expect(afterClaim.oq_referral_id).toBeUndefined();
    expect(afterClaim.oq_referral_agent_id).toBeUndefined();
    expect(afterClaim.oq_referral_code).toBeUndefined();
    expect(document.cookie).not.toContain('oq-ref=');
    expect(localStorage.getItem('oq_referral_id_for_claim')).toBeNull();
  });

  it('negative control: an UNRELATED claim save with no referral in play leaves nothing to clear (does not throw, does not fabricate attribution)', async () => {
    // No writeReferralIds() call — this browser never carried a referral.
    const payload = await completeCashSingleTradeWalk();

    expect(payload.referral_id).toBeUndefined();
    expect(payload.referral_agent_id).toBeUndefined();
    expect(readReferralIds()).toEqual({});
  });

  it('ROUND 2 FIX: a claim write that returns an error (RLS/constraint shape, NOT a thrown exception) does NOT clear a live referral', async () => {
    writeReferralIds(PARTNER_A_REFERRAL);

    // Supabase's real failure shape for an RLS denial or constraint
    // violation: the promise resolves normally, data is null, error is set.
    // No throw — this repo has no throwOnError() anywhere, so a handler
    // that only reacts to a thrown exception (or that ignores `error`
    // entirely, as round 1 did) never sees this as a failure at all.
    claimsInsertMock.mockImplementationOnce((_payload: Record<string, unknown>) => ({
      select: () => ({
        single: () =>
          Promise.resolve({
            data: null,
            error: { message: 'new row violates row-level security policy', code: '42501' },
          }),
      }),
    }));

    await completeCashSingleTradeWalk();

    // THE FIX: the write failed, so the referral was never durably
    // recorded against a claim — it is still live and must still
    // attribute correctly on the next, real attempt. Over-clearing here
    // is the same money-path defect as not clearing at all, just in the
    // opposite, under-pay-the-partner direction.
    const afterFailedWrite = readReferralIds();
    expect(afterFailedWrite.oq_referral_id).toBe(PARTNER_A_REFERRAL.oq_referral_id);
    expect(afterFailedWrite.oq_referral_agent_id).toBe(PARTNER_A_REFERRAL.oq_referral_agent_id);
    expect(afterFailedWrite.oq_referral_code).toBe(PARTNER_A_REFERRAL.oq_referral_code);
    expect(document.cookie).toContain('oq-ref=');
  });
});
