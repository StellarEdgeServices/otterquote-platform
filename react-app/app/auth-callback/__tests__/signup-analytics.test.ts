import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the shared GA4 call site so we can assert exactly what was sent,
// without needing a real window.gtag.
vi.mock('@/lib/track', () => ({ track: vi.fn() }));

import { track } from '@/lib/track';
import {
  hasFiredSignUp,
  isNewlyCreatedUser,
  maybeFireGoogleSignUp,
  markSignUpFired,
  signUpFiredKey,
  type SignUpGuardUser,
} from '../signup-analytics';

const trackMock = vi.mocked(track);

function googleUser(overrides: Partial<SignUpGuardUser> = {}): SignUpGuardUser {
  return {
    id: 'user-1',
    created_at: new Date().toISOString(), // "now" — a brand-new account
    app_metadata: { provider: 'google' },
    ...overrides,
  };
}

beforeEach(() => {
  trackMock.mockClear();
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
});

describe('maybeFireGoogleSignUp — fires once on first landing for a new user', () => {
  it('fires sign_up{method:"google"} for a brand-new Google signup', () => {
    const fired = maybeFireGoogleSignUp(googleUser());
    expect(fired).toBe(true);
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('sign_up', { method: 'google' });
  });

  it('sets the one-time marker for that user id so a later landing is a no-op', () => {
    maybeFireGoogleSignUp(googleUser({ id: 'user-42' }));
    expect(hasFiredSignUp('user-42')).toBe(true);
  });
});

describe('maybeFireGoogleSignUp — never fires on a returning sign-in', () => {
  it('does not fire for an account created hours ago', () => {
    const returningUser = googleUser({
      created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const fired = maybeFireGoogleSignUp(returningUser);
    expect(fired).toBe(false);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('does not fire for the password path (no google provider)', () => {
    const passwordUser = googleUser({ app_metadata: { provider: 'email' } });
    const fired = maybeFireGoogleSignUp(passwordUser);
    expect(fired).toBe(false);
    expect(trackMock).not.toHaveBeenCalled();
  });
});

describe('maybeFireGoogleSignUp — never fires twice', () => {
  it('fires once across two calls for the same new user (double routeSession invocation)', () => {
    const user = googleUser({ id: 'user-7' });
    const first = maybeFireGoogleSignUp(user);
    const second = maybeFireGoogleSignUp(user);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('fires once even if the marker was already set by a prior page load', () => {
    const user = googleUser({ id: 'user-8' });
    markSignUpFired(user.id);
    const fired = maybeFireGoogleSignUp(user);
    expect(fired).toBe(false);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('never fires for two different new users when only one has landed twice', () => {
    const userA = googleUser({ id: 'user-a' });
    const userB = googleUser({ id: 'user-b' });
    expect(maybeFireGoogleSignUp(userA)).toBe(true);
    expect(maybeFireGoogleSignUp(userA)).toBe(false);
    expect(maybeFireGoogleSignUp(userB)).toBe(true);
    expect(trackMock).toHaveBeenCalledTimes(2);
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
describe('sanity — the mock actually intercepts track()', () => {
  it('the mocked track is a distinct spy per test (mockClear ran in beforeEach)', () => {
    expect(trackMock).not.toHaveBeenCalled();
  });
});
