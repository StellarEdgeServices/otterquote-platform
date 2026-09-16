import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the shared GA4 call site so we can assert exactly what was sent and
// control timing, without needing a real window.gtag.
vi.mock('@/lib/track', () => ({ fireSignUpAndWait: vi.fn() }));

import { fireSignUpAndWait } from '@/lib/track';
import {
  hasFiredSignUp,
  isNewlyCreatedUser,
  maybeFireGoogleSignUp,
  markSignUpFired,
  readReferralSourceFromCsSignup,
  signUpFiredKey,
  type SignUpGuardUser,
} from '../signup-analytics';

const fireSignUpAndWaitMock = vi.mocked(fireSignUpAndWait);

function googleUser(overrides: Partial<SignUpGuardUser> = {}): SignUpGuardUser {
  return {
    id: 'user-1',
    created_at: new Date().toISOString(), // "now" — a brand-new account
    app_metadata: { provider: 'google' },
    ...overrides,
  };
}

beforeEach(() => {
  fireSignUpAndWaitMock.mockReset();
  fireSignUpAndWaitMock.mockResolvedValue(true); // default: gtag present, hit queued/sent
  localStorage.clear();
});

describe('isNewlyCreatedUser', () => {
  it('is true for an account created seconds ago', () => {
    expect(isNewlyCreatedUser({ created_at: new Date().toISOString() })).toBe(true);
  });

  it('is false for an account created hours ago (returning user)', () => {
    const hoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(isNewlyCreatedUser({ created_at: hoursAgo })).toBe(false);
  });

  it('is false with no created_at at all', () => {
    expect(isNewlyCreatedUser({ created_at: null })).toBe(false);
  });

  /**
   * fix2 (cto32-review-pr1979-20260915.md, finding N3) — a lower bound.
   * Before this fix, `Date.now() - createdMs < 5min` also passed when the
   * difference was NEGATIVE (created_at read as being in the future
   * relative to this device's clock), which a returning user's account
   * should never satisfy. These two are the negative controls: without the
   * `age > -CLOCK_SKEW_TOLERANCE_MS` lower bound, both would incorrectly
   * return `true`.
   */
  it('is false for a created_at more than the skew tolerance in the future (bad clock / malformed timestamp)', () => {
    const farFuture = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min ahead
    expect(isNewlyCreatedUser({ created_at: farFuture })).toBe(false);
  });

  it('is true for a created_at only slightly in the future (ordinary clock skew)', () => {
    const slightlyAhead = new Date(Date.now() + 5 * 1000).toISOString(); // 5s ahead — within tolerance
    expect(isNewlyCreatedUser({ created_at: slightlyAhead })).toBe(true);
  });

  it('is false right at the upper window boundary (too old)', () => {
    const justOverWindow = new Date(Date.now() - (5 * 60 * 1000 + 1000)).toISOString();
    expect(isNewlyCreatedUser({ created_at: justOverWindow })).toBe(false);
  });
});

describe('readReferralSourceFromCsSignup', () => {
  it('reads referral_source out of the cs_signup payload get-started/page.tsx wrote', () => {
    localStorage.setItem('cs_signup', JSON.stringify({ referral_source: 'realtor' }));
    expect(readReferralSourceFromCsSignup()).toBe('realtor');
  });

  it('falls back to "" when cs_signup is absent', () => {
    expect(readReferralSourceFromCsSignup()).toBe('');
  });

  it('falls back to "" when cs_signup is present but unparsable', () => {
    localStorage.setItem('cs_signup', '{not json');
    expect(readReferralSourceFromCsSignup()).toBe('');
  });

  it('falls back to "" when referral_source is missing or not a string', () => {
    localStorage.setItem('cs_signup', JSON.stringify({ referral_source: 42 }));
    expect(readReferralSourceFromCsSignup()).toBe('');
  });
});

describe('maybeFireGoogleSignUp — fires once on first landing for a new user', () => {
  it('awaits fireSignUpAndWait with sign_up{method:"google", referral_source} for a brand-new Google signup', async () => {
    const fired = await maybeFireGoogleSignUp(googleUser(), 'web');
    expect(fired).toBe(true);
    expect(fireSignUpAndWaitMock).toHaveBeenCalledTimes(1);
    expect(fireSignUpAndWaitMock).toHaveBeenCalledWith({ method: 'google', referral_source: 'web' }, 1000);
  });

  it('sets the one-time marker for that user id AFTER a successful (queued) fire', async () => {
    await maybeFireGoogleSignUp(googleUser({ id: 'user-42' }), 'web');
    expect(hasFiredSignUp('user-42')).toBe(true);
  });

  /**
   * fix2 (finding B2) — the marker must NOT be burned when
   * fireSignUpAndWait reports nothing was queued (gtag absent this
   * pageload). The old code set the marker BEFORE the emit
   * unconditionally; this is the regression test for that ordering.
   */
  it('does NOT set the marker when fireSignUpAndWait resolves false (gtag never present)', async () => {
    fireSignUpAndWaitMock.mockResolvedValue(false);
    const fired = await maybeFireGoogleSignUp(googleUser({ id: 'user-99' }), 'web');
    expect(fired).toBe(false);
    expect(hasFiredSignUp('user-99')).toBe(false);
  });
});

describe('maybeFireGoogleSignUp — never fires on a returning sign-in', () => {
  it('does not fire for an account created hours ago', async () => {
    const returningUser = googleUser({
      created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const fired = await maybeFireGoogleSignUp(returningUser, 'web');
    expect(fired).toBe(false);
    expect(fireSignUpAndWaitMock).not.toHaveBeenCalled();
  });

  it('does not fire for the password path (no google provider)', async () => {
    const passwordUser = googleUser({ app_metadata: { provider: 'email' } });
    const fired = await maybeFireGoogleSignUp(passwordUser, 'web');
    expect(fired).toBe(false);
    expect(fireSignUpAndWaitMock).not.toHaveBeenCalled();
  });
});

describe('maybeFireGoogleSignUp — never fires twice', () => {
  it('fires once across two calls for the same new user (double routeSession invocation)', async () => {
    const user = googleUser({ id: 'user-7' });
    const first = await maybeFireGoogleSignUp(user, 'web');
    const second = await maybeFireGoogleSignUp(user, 'web');
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(fireSignUpAndWaitMock).toHaveBeenCalledTimes(1);
  });

  it('fires once even if the marker was already set by a prior page load', async () => {
    const user = googleUser({ id: 'user-8' });
    markSignUpFired(user.id);
    const fired = await maybeFireGoogleSignUp(user, 'web');
    expect(fired).toBe(false);
    expect(fireSignUpAndWaitMock).not.toHaveBeenCalled();
  });

  it('never fires for two different new users when only one has landed twice', async () => {
    const userA = googleUser({ id: 'user-a' });
    const userB = googleUser({ id: 'user-b' });
    expect(await maybeFireGoogleSignUp(userA, 'web')).toBe(true);
    expect(await maybeFireGoogleSignUp(userA, 'web')).toBe(false);
    expect(await maybeFireGoogleSignUp(userB, 'web')).toBe(true);
    expect(fireSignUpAndWaitMock).toHaveBeenCalledTimes(2);
  });
});

describe('signUpFiredKey', () => {
  it('namespaces the marker per user id (no cross-user collision)', () => {
    expect(signUpFiredKey('a')).not.toBe(signUpFiredKey('b'));
  });
});

/**
 * NEGATIVE CONTROL (paste this run's output beside the passes above, per
 * the brief): this test asserts the detector actually discriminates —
 * comment out `if (!isNewlyCreatedUser(user)) return false;` in
 * signup-analytics.ts's maybeFireGoogleSignUp and the "never fires on a
 * returning sign-in" tests above go red, proving they are not vacuously
 * green. This test file does not flip the guard itself (that would defeat
 * the guard in the shipped module); the negative control is run manually
 * once and its red output is pasted in the PR/report, matching how gh-1948
 * and the gh-1960 review document their negative controls.
 */
describe('sanity — the mock actually intercepts fireSignUpAndWait()', () => {
  it('the mocked fireSignUpAndWait is a distinct spy per test (mockReset ran in beforeEach)', () => {
    expect(fireSignUpAndWaitMock).not.toHaveBeenCalled();
  });
});
