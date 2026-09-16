/**
 * gh-1940 fix2 (cto32-review-pr1979-20260915.md, findings B1/B2) — regression
 * test for the removed pre-redirect Google `sign_up`. Renders the actual
 * page component (not just its utils) so a re-added `track('sign_up', ...)`
 * call anywhere in the Google path would turn this red (kills mutant M10:
 * re-adding get-started's pre-redirect Google sign_up).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({ user: null, role: null, loading: false }),
}));

vi.mock('@/lib/supabase', () => {
  const leadsBuilder = { insert: vi.fn(() => Promise.resolve({ error: null })) };
  return {
    supabase: {
      auth: { signInWithOAuth: vi.fn(() => Promise.resolve({ error: null })) },
      from: vi.fn(() => leadsBuilder),
    },
  };
});

vi.mock('@/lib/cookie-storage', () => ({
  readReferralIds: vi.fn(() => ({})),
  writeReferralIds: vi.fn(),
}));

import GetStartedPage from '../page';

describe('get-started page — Google OAuth path fires no pre-redirect sign_up', () => {
  let gtagSpy: ReturnType<typeof vi.fn>;
  let fbqSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gtagSpy = vi.fn();
    fbqSpy = vi.fn();
    (window as unknown as { gtag?: unknown }).gtag = gtagSpy;
    (window as unknown as { fbq?: unknown }).fbq = fbqSpy;
    localStorage.clear();
  });

  afterEach(() => {
    delete (window as unknown as { gtag?: unknown }).gtag;
    delete (window as unknown as { fbq?: unknown }).fbq;
    vi.clearAllMocks();
  });

  it('emits homeowner_signup + Meta Lead but NOT sign_up when signing up with Google', async () => {
    render(<GetStartedPage />);

    // Step 1 — property address, then Continue to Step 2.
    fireEvent.change(screen.getByLabelText('Property Address'), {
      target: { value: '1 Otter Way' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Step 2 — name (required even for the Google path).
    await screen.findByLabelText('First Name');
    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Doe' } });

    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));

    await waitFor(() => expect(gtagSpy).toHaveBeenCalled());

    const eventNames = gtagSpy.mock.calls
      .filter((call) => call[0] === 'event')
      .map((call) => call[1]);
    expect(eventNames).not.toContain('sign_up');
    expect(eventNames).toContain('homeowner_signup');
    expect(fbqSpy).toHaveBeenCalledWith('track', 'Lead');

    // cs_signup still carries referral_source for the auth-callback landing
    // to read (readReferralSourceFromCsSignup) — regression guard that the
    // removal above did not also drop the data the landing event needs.
    const csSignup = JSON.parse(localStorage.getItem('cs_signup') || '{}');
    expect(csSignup).toHaveProperty('referral_source');
  });
});
