/**
 * Parity tests for React /contractor/login — D-211 P4.
 *
 * Proves the React /contractor/login route matches the static
 * contractor-login.html on the things that matter for a pre-auth entry page:
 *   1. D-244 verbatim-locked login-path copy (byte-for-byte).
 *   2. Email-validation + redirect-target logic (same regex, contractor intent).
 *   3. Rendered behavior: Google OAuth + magic-link wiring (cs_auth_role=
 *      'contractor'), sent-state copy, homeowner sibling + join-CTA links, and
 *      contractor-scoped already-authenticated handling.
 *
 * Byte-for-byte literals below are copied directly from contractor-login.html
 * @ main (commit 6a93d62). contractor-login.html has its OWN wording — it is
 * NOT identical to login.html (P3). (login.test.tsx is the structural model.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { seedStaleStorage } from '@/test/storage-fixtures';

// Mock the Supabase singleton (no env / network in unit tests) and the auth hook.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOAuth: vi.fn(),
    },
  },
}));
// gh-1883 [SECURITY]: magic-link send/resend now goes through auth-uniform
// (lib/auth-uniform.ts), not supabase.auth.signInWithOtp() directly.
vi.mock('@/lib/auth-uniform', () => ({ callAuthUniform: vi.fn() }));
// gh-1980 PR 3/3 (Google-only PKCE): Google now initiates through
// lib/supabase-oauth.ts (a dedicated pkce client). Delegate to the mocked
// shared client so this test keeps asserting the exact OAuth call the page makes.
vi.mock('@/lib/supabase-oauth', async () => {
  const { supabase } = await import('@/lib/supabase');
  return {
    signInWithGoogleOAuth: (options: unknown) =>
      (supabase.auth.signInWithOAuth as (a: unknown) => unknown)({ provider: 'google', options }),
  };
});

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));

import { supabase } from '@/lib/supabase';
import { callAuthUniform } from '@/lib/auth-uniform';
import { useAuthReady } from '@/hooks/use-auth-ready';
import ContractorLoginPage from '../page';
import { CONTRACTOR_LOGIN_COPY } from '../copy';
import {
  isValidEmail,
  cameFromContractorDashboard,
  AUTH_CALLBACK_URL,
  GOOGLE_OAUTH_REDIRECT,
  CONTRACTOR_DASHBOARD_URL,
  CONTRACTOR_JOIN_URL,
  LOGIN_URL,
} from '../utils';
import { markContractorGateBounce } from '@/lib/contractor-gate';

// ── Exact strings from static contractor-login.html @ 6a93d62 ──
const STATIC = {
  title: 'Contractor Login',
  subtitle:
    'Sign in to your Otter Quotes contractor portal to view opportunities, manage bids, and track your projects.',
  emailLabel: 'Business Email',
  emailHint: "We'll send you a secure login link — no password needed.",
  submit: 'Send Login Link',
  google: 'Sign in with Google',
  divider: 'or continue with email',
  homeownerPrefix: 'Are you a homeowner?',
  homeownerLink: 'Sign in to your account',
  joinPrompt: 'New to Otter Quotes? Apply to join our contractor network.',
  joinButton: 'Apply to Join',
  // D-244 verbatim-locked
  sentHeading: 'Check Your Email',
  sentBody: 'If an account exists, we sent a link.',
  sentExpiry: 'If you receive a link, it will expire in 1 hour.',
  sentResend: "Didn't get it? Send again",
  resendAlert: 'If an account exists, we sent a link.',
  // right panel
  benefitsHeading:
    'Otter Quotes is not a referral service. We are your marketing department and sales force all rolled into one!',
};

function asUnauthenticated() {
  (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    user: null, role: null, isAdmin: false, loading: false, signOut: vi.fn(),
  });
}
function asHomeowner() {
  (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    user: { id: 'u1' }, role: 'homeowner', isAdmin: false, loading: false, signOut: vi.fn(),
  });
}
function asContractor() {
  (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    user: { id: 'c1' }, role: 'contractor', isAdmin: false, loading: false, signOut: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
  localStorage.clear();
  sessionStorage.clear();
  (callAuthUniform as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (supabase.auth.signInWithOAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ error: null });
});

describe('D-244 verbatim-locked login copy (byte-for-byte)', () => {
  it('matches the static contractor-login.html magic-link-sent + resend copy exactly', () => {
    expect(CONTRACTOR_LOGIN_COPY.sentHeading).toBe(STATIC.sentHeading);
    expect(CONTRACTOR_LOGIN_COPY.sentBody).toBe(STATIC.sentBody);
    expect(CONTRACTOR_LOGIN_COPY.sentExpiry).toBe(STATIC.sentExpiry);
    expect(CONTRACTOR_LOGIN_COPY.sentResend).toBe(STATIC.sentResend);
    expect(CONTRACTOR_LOGIN_COPY.resendAlert).toBe(STATIC.resendAlert);
  });

  it('matches the static form + panel copy exactly', () => {
    expect(CONTRACTOR_LOGIN_COPY.title).toBe(STATIC.title);
    expect(CONTRACTOR_LOGIN_COPY.subtitle).toBe(STATIC.subtitle);
    expect(CONTRACTOR_LOGIN_COPY.emailLabel).toBe(STATIC.emailLabel);
    expect(CONTRACTOR_LOGIN_COPY.emailHint).toBe(STATIC.emailHint);
    expect(CONTRACTOR_LOGIN_COPY.submitButton).toBe(STATIC.submit);
    expect(CONTRACTOR_LOGIN_COPY.googleButton).toBe(STATIC.google);
    expect(CONTRACTOR_LOGIN_COPY.oauthDivider).toBe(STATIC.divider);
    expect(CONTRACTOR_LOGIN_COPY.homeownerPrefix).toBe(STATIC.homeownerPrefix);
    expect(CONTRACTOR_LOGIN_COPY.homeownerLink).toBe(STATIC.homeownerLink);
    expect(CONTRACTOR_LOGIN_COPY.joinPrompt).toBe(STATIC.joinPrompt);
    expect(CONTRACTOR_LOGIN_COPY.joinButton).toBe(STATIC.joinButton);
    expect(CONTRACTOR_LOGIN_COPY.benefitsHeading).toBe(STATIC.benefitsHeading);
  });
});

describe('email validation parity (same regex as contractor-login.html)', () => {
  it('accepts valid addresses', () => {
    expect(isValidEmail('you@yourcompany.com')).toBe(true);
    expect(isValidEmail('user+tag@domain.org')).toBe(true);
    expect(isValidEmail('a@b.co')).toBe(true);
  });
  it('rejects invalid addresses', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('notanemail')).toBe(false);
    expect(isValidEmail('@domain.com')).toBe(false);
    expect(isValidEmail('user@')).toBe(false);
    expect(isValidEmail('user @domain.com')).toBe(false);
  });
});

describe('redirect targets parity (contractor intent)', () => {
  it('magic link lands on the React auth-callback; OAuth carries intent=contractor', () => {
    expect(AUTH_CALLBACK_URL).toBe('https://app.otterquote.com/auth-callback');
    expect(GOOGLE_OAUTH_REDIRECT).toBe('https://app.otterquote.com/auth-callback?intent=contractor');
  });
  it('contractor dashboard points at the live React route; join + login stay static', () => {
    expect(CONTRACTOR_DASHBOARD_URL).toBe('/contractor/dashboard');
    expect(CONTRACTOR_JOIN_URL).toBe('https://otterquote.com/contractor-join.html');
    expect(LOGIN_URL).toBe('https://otterquote.com/login.html');
  });
  it('dashboard ↔ login flip guard detects a return-bounce from either stack', () => {
    expect(cameFromContractorDashboard('https://otterquote.com/contractor-dashboard.html')).toBe(true);
    expect(cameFromContractorDashboard('https://app.otterquote.com/contractor/dashboard')).toBe(true);
    expect(cameFromContractorDashboard('https://otterquote.com/get-started.html')).toBe(false);
    expect(cameFromContractorDashboard('')).toBe(false);
    expect(cameFromContractorDashboard(null)).toBe(false);
  });
});

describe('<ContractorLoginPage /> rendered behavior (unauthenticated)', () => {
  beforeEach(asUnauthenticated);

  it('renders the locked form copy, Google button, and entry links', () => {
    render(<ContractorLoginPage />);
    expect(screen.getByText(STATIC.title)).toBeInTheDocument();
    expect(screen.getByText(STATIC.subtitle)).toBeInTheDocument();
    expect(screen.getByText(STATIC.google)).toBeInTheDocument();
    expect(screen.getByText(STATIC.divider)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: STATIC.submit })).toBeInTheDocument();
    expect(screen.getByText(STATIC.benefitsHeading)).toBeInTheDocument();

    const homeownerLink = screen.getByText(STATIC.homeownerLink).closest('a');
    expect(homeownerLink).toHaveAttribute('href', LOGIN_URL);
    const joinLink = screen.getByText(STATIC.joinButton).closest('a');
    expect(joinLink).toHaveAttribute('href', CONTRACTOR_JOIN_URL);
  });

  it('rejects an invalid email without calling Supabase', () => {
    render(<ContractorLoginPage />);
    fireEvent.change(screen.getByPlaceholderText(CONTRACTOR_LOGIN_COPY.emailPlaceholder), {
      target: { value: 'notanemail' },
    });
    fireEvent.click(screen.getByRole('button', { name: STATIC.submit }));
    expect(screen.getByText(CONTRACTOR_LOGIN_COPY.errorInvalidEmail)).toBeInTheDocument();
    expect(callAuthUniform).not.toHaveBeenCalled();
  });

  it('sends a contractor magic link and shows the D-244 sent state', async () => {
    render(<ContractorLoginPage />);
    fireEvent.change(screen.getByPlaceholderText(CONTRACTOR_LOGIN_COPY.emailPlaceholder), {
      target: { value: 'pro@roofco.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: STATIC.submit }));

    await waitFor(() => expect(screen.getByText(STATIC.sentHeading)).toBeInTheDocument());
    expect(screen.getByText(STATIC.sentBody)).toBeInTheDocument();
    expect(screen.getByText(STATIC.sentExpiry)).toBeInTheDocument();
    expect(screen.getByText(STATIC.sentResend)).toBeInTheDocument();
    expect(screen.getByText('pro@roofco.com')).toBeInTheDocument();

    expect(callAuthUniform).toHaveBeenCalledWith('otp', 'pro@roofco.com', AUTH_CALLBACK_URL);
    expect(localStorage.getItem('cs_auth_role')).toBe('contractor');
    // gh-2060 RETURNED item 1 (contractor magic-link writer): /auth-callback
    // only trusts cs_auth_role when cs_auth_role_at is present and within
    // its 24h TTL — this must fail if the stamp write is deleted.
    const stampRaw = localStorage.getItem('cs_auth_role_at');
    expect(stampRaw).not.toBeNull();
    expect(Number.isFinite(Number(stampRaw))).toBe(true);
    expect(Date.now() - Number(stampRaw)).toBeLessThan(5000);
  });

  it('gh-2060 round-4: a resend >24h after the first send re-stamps cs_auth_role, so the emailed link still routes as contractor', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    render(<ContractorLoginPage />);
    fireEvent.change(screen.getByPlaceholderText(CONTRACTOR_LOGIN_COPY.emailPlaceholder), {
      target: { value: 'pro@roofco.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: STATIC.submit }));
    await waitFor(() => expect(screen.getByText(STATIC.sentResend)).toBeInTheDocument());

    // A day and an hour later the visitor finally hits "Send again": the
    // breadcrumb from the first send is already past its 24h TTL (and would
    // be read as absent by /auth-callback). Seeded dirty, per the harness.
    seedStaleStorage({
      localStorage: {
        cs_auth_role: 'contractor',
        cs_auth_role_at: String(Date.now() - 25 * 60 * 60 * 1000),
      },
    });

    fireEvent.click(screen.getByText(STATIC.sentResend));
    await waitFor(() => expect(callAuthUniform).toHaveBeenCalledTimes(2));

    expect(localStorage.getItem('cs_auth_role')).toBe('contractor');
    const stamp = Number(localStorage.getItem('cs_auth_role_at'));
    expect(Number.isFinite(stamp)).toBe(true);
    expect(Date.now() - stamp).toBeLessThan(5000);
  });

  it('starts Google OAuth with the contractor-intent callback', async () => {
    render(<ContractorLoginPage />);
    fireEvent.click(screen.getByText(STATIC.google));
    await waitFor(() =>
      expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
        provider: 'google',
        options: { redirectTo: GOOGLE_OAUTH_REDIRECT },
      }),
    );
    expect(localStorage.getItem('cs_auth_role')).toBe('contractor');
    // gh-2060 RETURNED item 1 (contractor Google OAuth writer): same TTL-
    // stamp requirement as the magic-link writer above.
    const stampRaw = localStorage.getItem('cs_auth_role_at');
    expect(stampRaw).not.toBeNull();
    expect(Number.isFinite(Number(stampRaw))).toBe(true);
    expect(Date.now() - Number(stampRaw)).toBeLessThan(5000);
  });
});

describe('<ContractorLoginPage /> already-authenticated handling', () => {
  it('keeps an authenticated homeowner on the page so they can sign in as a contractor', () => {
    asHomeowner();
    render(<ContractorLoginPage />);
    // role !== 'contractor' → no redirect → the contractor sign-in form is still shown.
    expect(screen.getByRole('button', { name: STATIC.submit })).toBeInTheDocument();
    expect(screen.getByText(STATIC.title)).toBeInTheDocument();
  });

  it('stays on the page (breaks the loop) when ContractorShell just bounced here', () => {
    // A fresh gate-bounce one-shot marker means the shell ejected this request in
    // the dashboard cold-load window; do NOT send the authed contractor straight
    // back (postmortem 2026-06-16). The form stays visible — no redirect.
    markContractorGateBounce();
    asContractor();
    render(<ContractorLoginPage />);
    expect(screen.getByRole('button', { name: STATIC.submit })).toBeInTheDocument();
    expect(screen.getByText(STATIC.title)).toBeInTheDocument();
  });
});
