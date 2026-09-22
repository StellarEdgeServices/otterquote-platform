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
 *
 * ROUND 3 (REVIEW: FAIL on PR #2103, again): `error === null` is NOT
 * success. handleComplete's UPDATE branch (existingClaim truthy — a
 * homeowner revisiting trade-selector after already starting a claim) had
 * no `.select()`, and an UPDATE that matches ZERO rows (e.g. RLS silently
 * filtering the WHERE match) still resolves with `error: null` in
 * PostgREST/Supabase. Round 2's `claimWriteSucceeded = !updateError` was
 * therefore true on a write that wrote nothing. Worse: every test in this
 * file up through round 2 was structurally forced down the INSERT branch
 * by `maybeSingle()` always resolving `{ data: null }` (never an
 * `existingClaim`) — the update branch was untested, not merely
 * under-tested. `claimsMaybeSingleMock` and `claimsUpdateSelectMock` below
 * make the update branch reachable; the fifth test below is the one that
 * would have caught this: an UPDATE that returns zero rows with no error
 * must leave the cookie alone.
 *
 * Branch coverage, stated explicitly per the round-3 review's ask:
 *   - Tests 1-4 (POSITIVE CONTROL, round-1 FIX, negative control, round-2
 *     FIX) all drive the INSERT branch (existingClaim absent — the default
 *     `claimsMaybeSingleMock` resolution).
 *   - Test 5 (round-3 FIX) drives the UPDATE branch (existingClaim
 *     present, via `claimsMaybeSingleMock.mockImplementation`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { claimsInsertMock, claimsUpdateSelectMock, claimsMaybeSingleMock } = vi.hoisted(() => ({
  claimsInsertMock: vi.fn((_payload: Record<string, unknown>) => ({
    select: () => ({
      single: () => Promise.resolve({ data: { id: 'test-claim-id' }, error: null }),
    }),
  })),
  // The terminal call of .update(...).eq('id', existingClaim.id).select('id')
  // — defaults to "one row actually updated", matching the vast majority of
  // real update passes (own-claim update, no RLS mismatch).
  claimsUpdateSelectMock: vi.fn(() => Promise.resolve({ data: [{ id: 'existing-claim-id' }], error: null })),
  // Drives which branch handleComplete takes: null/undefined -> INSERT
  // (no existing claim found), a row -> UPDATE. Defaults to INSERT, as all
  // rounds 1-2 tests implicitly assumed.
  claimsMaybeSingleMock: vi.fn(() => Promise.resolve({ data: null, error: null })),
}));

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/lib/supabase', () => {
  const claimsSelectChain = {
    select: () => claimsSelectChain,
    eq: () => claimsSelectChain,
    order: () => claimsSelectChain,
    limit: () => claimsSelectChain,
    maybeSingle: claimsMaybeSingleMock,
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
            // Mirrors the real chain: .update(payload).eq('id', id).select('id')
            update: () => ({ eq: () => ({ select: claimsUpdateSelectMock }) }),
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
    // Explicit .mockReset() + re-arm of the default implementation for
    // every mock a test might override with .mockImplementationOnce():
    // clearAllMocks()/restoreAllMocks() clear call history but are not
    // guaranteed across vitest versions to also drain a queued "once"
    // implementation left over from a test that didn't end up calling it
    // (e.g. one that exercises the other claims-write branch). A leaked
    // once-queue entry would silently apply to the wrong test. Reset each
    // to a known-good default explicitly rather than relying on that.
    claimsMaybeSingleMock.mockReset().mockImplementation(() => Promise.resolve({ data: null, error: null }));
    claimsUpdateSelectMock
      .mockReset()
      .mockImplementation(() => Promise.resolve({ data: [{ id: 'existing-claim-id' }], error: null }));
    claimsInsertMock.mockReset().mockImplementation((_payload: Record<string, unknown>) => ({
      select: () => ({
        single: () => Promise.resolve({ data: { id: 'test-claim-id' }, error: null }),
      }),
    }));
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

  /** Same walk, but drives the UPDATE branch (a homeowner revisiting
   *  trade-selector after already starting a claim) instead of INSERT —
   *  reachable only because claimsMaybeSingleMock is overridden to resolve
   *  an existing claim before calling this. */
  async function completeCashSingleTradeWalkViaUpdate() {
    localStorage.setItem('cs_signup', JSON.stringify(CS_SIGNUP));
    render(<TradeSelectorPage />);

    fireEvent.click(screen.getByText("I'm paying for this myself (retail/cash)"));
    await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Roofing'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('Repair or Replace?')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(claimsUpdateSelectMock).toHaveBeenCalledTimes(1));
    // The insert path must NOT have also fired — confirms this test is
    // really exercising the update branch, not silently falling through.
    expect(claimsInsertMock).not.toHaveBeenCalled();
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

  it('ROUND 3 sanity: a real (row-affecting) UPDATE still clears a consumed referral (update branch, positive)', async () => {
    writeReferralIds(PARTNER_A_REFERRAL);
    // .mockImplementation (not Once): the component's own mount-time
    // "returning user already has a claim" guard (a separate maybeSingle()
    // call, harmless no-op redirect under our window.location mock) AND
    // handleComplete's own existing-claim check both need to see the same
    // existing claim for this to be internally consistent and reach the
    // update branch.
    claimsMaybeSingleMock.mockImplementation(() =>
      Promise.resolve({ data: { id: 'existing-claim-id' }, error: null }),
    );
    // claimsUpdateSelectMock default already resolves one row — this test
    // just confirms the update branch behaves like the insert branch's
    // positive control once round 3's row-count check is satisfied.

    await completeCashSingleTradeWalkViaUpdate();

    expect(readReferralIds()).toEqual({});
    expect(document.cookie).not.toContain('oq-ref=');
  });

  it('ROUND 3 FIX: an UPDATE that matches ZERO rows (RLS-filtered, error: null) does NOT clear a live referral', async () => {
    writeReferralIds(PARTNER_A_REFERRAL);
    claimsMaybeSingleMock.mockImplementation(() =>
      Promise.resolve({ data: { id: 'existing-claim-id' }, error: null }),
    );
    // THE round-3 BUG'S EXACT SHAPE: no error, but the WHERE match found
    // zero rows — e.g. RLS silently filtered it out. PostgREST/Supabase do
    // not treat "zero rows updated" as an error by default.
    claimsUpdateSelectMock.mockImplementationOnce(() => Promise.resolve({ data: [], error: null }));

    await completeCashSingleTradeWalkViaUpdate();

    // THE FIX: nothing was actually written, so the referral was never
    // durably recorded against the claim — it must still be live.
    const afterZeroRowUpdate = readReferralIds();
    expect(afterZeroRowUpdate.oq_referral_id).toBe(PARTNER_A_REFERRAL.oq_referral_id);
    expect(afterZeroRowUpdate.oq_referral_agent_id).toBe(PARTNER_A_REFERRAL.oq_referral_agent_id);
    expect(afterZeroRowUpdate.oq_referral_code).toBe(PARTNER_A_REFERRAL.oq_referral_code);
    expect(document.cookie).toContain('oq-ref=');
  });
});
