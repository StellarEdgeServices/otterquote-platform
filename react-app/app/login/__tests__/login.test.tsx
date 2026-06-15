/**
 * Parity tests for React /login — D-211 P3.
 *
 * Proves the React /login route matches the static login.html on the three
 * things that matter for a pre-auth entry page:
 *   1. D-244 verbatim-locked login-path copy (byte-for-byte).
 *   2. Email-validation + redirect-target logic (same regex, same destinations).
 *   3. Rendered behavior: Google OAuth + magic-link wiring, sent-state copy,
 *      contractor/create-account links, and the admin-required banner.
 *
 * The byte-for-byte literals below are copied directly from login.html @ main
 * (commit d26427d) — if either side drifts, this test fails. (get-started test
 * is the structural model.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock the Supabase singleton (no env / network in unit tests) and the auth hook.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOtp: vi.fn(),
      signInWithOAuth: vi.fn(),
    },
  },
}));
vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));

import { supabase } from '@/lib/supabase';
import { useAuthReady } from '@/hooks/use-auth-ready';
import LoginPage from '../page';
import { LOGIN_COPY } from '../copy';
import {
  isValidEmail,
  dashboardUrlForRole,
  AUTH_CALLBACK_URL,
  GOOGLE_OAUTH_REDIRECT,
  DASHBOARD_URL,
  CONTRACTOR_DASHBOARD_URL,
  CONTRACTOR_LOGIN_URL,
  GET_STARTED_URL,
} from '../utils';

// ── Exact strings from static login.html @ d26427d ──
const STATIC = {
  title: 'Welcome Back',
  subtitle:
    "Enter your email and we'll send you a secure link to access your project dashboard. No password needed.",
  emailLabel: 'Email Address',
  emailHint: "We'll send a one-click login link to this address.",
  submit: 'Send Login Link',
  google: 'Sign in with Google',
  divider: 'or continue with email',
  noAccountLink: 'Create one free',
  contractorLink: 'Sign in to your contractor account',
  adminStrong: 'Admin access required.',
  // D-244 verbatim-locked
  sentHeading: 'Check Your Email',
  sentBody: 'If an account exists, we sent a link.',
  sentExpiry: 'If you receive a link, it will expire in 1 hour.',
  sentResend: "Didn't get it? Send again",
  resendAlert: 'If an account exists, we sent a link.',
  // right panel
  infoHeading: 'Your Project Dashboard',
};

function asUnauthenticated() {
  (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    user: null,
    role: null,
    isAdmin: false,
    loading: false,
    signOut: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
  (supabase.auth.signInWithOtp as ReturnType<typeof vi.fn>).mockResolvedValue({ error: null });
  (supabase.auth.signInWithOAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ error: null });
});

describe('D-244 verbatim-locked login copy (byte-for-byte)', () => {
  it('matches the static login.html magic-link-sent + resend copy exactly', () => {
    expect(LOGIN_COPY.sentHeading).toBe(STATIC.sentHeading);
    expect(LOGIN_COPY.sentBody).toBe(STATIC.sentBody);
    expect(LOGIN_COPY.sentExpiry).toBe(STATIC.sentExpiry);
    expect(LOGIN_COPY.sentResend).toBe(STATIC.sentResend);
    expect(LOGIN_COPY.resendAlert).toBe(STATIC.resendAlert);
  });

  it('matches the static form + panel copy exactly', () => {
    expect(LOGIN_COPY.title).toBe(STATIC.title);
    expect(LOGIN_COPY.subtitle).toBe(STATIC.subtitle);
    expect(LOGIN_COPY.emailLabel).toBe(STATIC.emailLabel);
    expect(LOGIN_COPY.emailHint).toBe(STATIC.emailHint);
    expect(LOGIN_COPY.submitButton).toBe(STATIC.submit);
    expect(LOGIN_COPY.googleButton).toBe(STATIC.google);
    expect(LOGIN_COPY.oauthDivider).toBe(STATIC.divider);
    expect(LOGIN_COPY.noAccountLink).toBe(STATIC.noAccountLink);
    expect(LOGIN_COPY.contractorLink).toBe(STATIC.contractorLink);
    expect(LOGIN_COPY.adminBannerStrong).toBe(STATIC.adminStrong);
    expect(LOGIN_COPY.infoHeading).toBe(STATIC.infoHeading);
  });
});

describe('email validation parity (same regex as login.html)', () => {
  it('accepts valid addresses', () => {
    expect(isValidEmail('jane@example.com')).toBe(true);
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

describe('redirect targets parity', () => {
  it('magic link + OAuth land on the React auth-callback', () => {
    expect(AUTH_CALLBACK_URL).toBe('https://app.otterquote.com/auth-callback');
    expect(GOOGLE_OAUTH_REDIRECT).toBe('https://app.otterquote.com/auth-callback?intent=homeowner');
  });
  it('cross-stack entry links point at the static app shell', () => {
    expect(GET_STARTED_URL).toBe('https://otterquote.com/get-started.html');
    expect(CONTRACTOR_LOGIN_URL).toBe('https://otterquote.com/contractor-login.html');
  });
  it('role branch mirrors Auth.redirectToDashboard', () => {
    expect(dashboardUrlForRole('contractor')).toBe(CONTRACTOR_DASHBOARD_URL);
    expect(dashboardUrlForRole('homeowner')).toBe(DASHBOARD_URL);
    expect(dashboardUrlForRole(null)).toBe(DASHBOARD_URL);
  });
});

describe('<LoginPage /> rendered behavior (unauthenticated)', () => {
  beforeEach(asUnauthenticated);

  it('renders the locked form copy, Google button, and entry links', () => {
    render(<LoginPage />);
    expect(screen.getByText(STATIC.title)).toBeInTheDocument();
    expect(screen.getByText(STATIC.subtitle)).toBeInTheDocument();
    expect(screen.getByText(STATIC.google)).toBeInTheDocument();
    expect(screen.getByText(STATIC.divider)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: STATIC.submit })).toBeInTheDocument();
    expect(screen.getByText(STATIC.infoHeading)).toBeInTheDocument();

    const createLink = screen.getByText(STATIC.noAccountLink).closest('a');
    expect(createLink).toHaveAttribute('href', GET_STARTED_URL);
    const contractorLink = screen.getByText(STATIC.contractorLink).closest('a');
    expect(contractorLink).toHaveAttribute('href', CONTRACTOR_LOGIN_URL);
  });

  it('rejects an invalid email without calling Supabase', () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText(LOGIN_COPY.emailPlaceholder), {
      target: { value: 'notanemail' },
    });
    fireEvent.click(screen.getByRole('button', { name: STATIC.submit }));
    expect(screen.getByText(LOGIN_COPY.errorInvalidEmail)).toBeInTheDocument();
    expect(supabase.auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it('sends a magic link and shows the D-244 sent state', async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText(LOGIN_COPY.emailPlaceholder), {
      target: { value: 'jane@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: STATIC.submit }));

    await waitFor(() => expect(screen.getByText(STATIC.sentHeading)).toBeInTheDocument());
    expect(screen.getByText(STATIC.sentBody)).toBeInTheDocument();
    expect(screen.getByText(STATIC.sentExpiry)).toBeInTheDocument();
    expect(screen.getByText(STATIC.sentResend)).toBeInTheDocument();
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();

    expect(supabase.auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'jane@example.com',
      options: { emailRedirectTo: AUTH_CALLBACK_URL },
    });
    expect(localStorage.getItem('cs_auth_role')).toBe('homeowner');
  });

  it('starts Google OAuth with the homeowner-intent callback', async () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByText(STATIC.google));
    await waitFor(() =>
      expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
        provider: 'google',
        options: { redirectTo: GOOGLE_OAUTH_REDIRECT },
      }),
    );
  });

  it('shows the admin-required banner when bounced from the admin gate', () => {
    window.history.replaceState({}, '', '/?reason=admin_required');
    render(<LoginPage />);
    expect(screen.getByText(STATIC.adminStrong)).toBeInTheDocument();
  });
});
