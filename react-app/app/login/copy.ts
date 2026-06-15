/**
 * Login page copy — D-211 P3 (port of static login.html)
 *
 * SINGLE SOURCE OF TRUTH for all user-facing strings on /login.
 * page.tsx renders ONLY from this object; the co-located parity test asserts
 * these constants byte-for-byte against the static login.html.
 *
 * ⚠️ D-244 VERBATIM-LOCKED LOGIN-PATH COPY ⚠️
 * The `sent*` and `resend*` strings below are the canonical login-path copy.
 * They are privacy-preserving by design ("If an account exists…") and MUST NOT
 * be changed without a security review + Dustin sign-off (D-244 is Tier-3).
 * Any edit here trips the parity test in __tests__/login.test.tsx.
 */

export const LOGIN_COPY = {
  // ── Document / SEO ──
  pageTitle: 'Sign In — Otter Quotes',

  // ── Admin-required banner (W4-P1, shown on ?reason=admin_required) ──
  adminBannerStrong: 'Admin access required.',
  adminBannerRest: ' Please sign in with your admin account to continue.',

  // ── Form ──
  title: 'Welcome Back',
  subtitle:
    "Enter your email and we'll send you a secure link to access your project dashboard. No password needed.",
  googleButton: 'Sign in with Google',
  googleRedirecting: 'Redirecting to Google…',
  oauthDivider: 'or continue with email',
  emailLabel: 'Email Address',
  emailPlaceholder: 'jane@example.com',
  emailHint: "We'll send a one-click login link to this address.",
  submitButton: 'Send Login Link',
  noAccountPrefix: "Don't have an account yet?",
  noAccountLink: 'Create one free',
  contractorPrefix: 'Are you a contractor?',
  contractorLink: 'Sign in to your contractor account',

  // ── Errors ──
  errorInvalidEmail: 'Please enter a valid email address.',
  errorGeneric: 'Something went wrong. Please try again.',
  errorGoogle: 'Google sign-in failed. Please try the email link instead.',

  // ── D-244 VERBATIM-LOCKED (magic-link sent state) ──
  sentHeading: 'Check Your Email',
  sentBody: 'If an account exists, we sent a link.',
  sentExpiry: 'If you receive a link, it will expire in 1 hour.',
  sentResend: "Didn't get it? Send again",
  resendAlert: 'If an account exists, we sent a link.',
  resendErrorAlert: 'Could not resend. Please try again in a moment.',

  // ── Right info panel ──
  infoHeading: 'Your Project Dashboard',
  info: [
    {
      icon: '📊',
      h: 'Track your project',
      p: 'See your project status, uploaded documents, and material selections in one place.',
    },
    {
      icon: '💰',
      h: 'Review incoming bids',
      p: 'Compare bids from qualified contractors and select the best offer for your project.',
    },
    {
      icon: '📝',
      h: 'Sign your contract',
      p: 'E-sign your contractor agreement securely — no printing, scanning, or faxing required.',
    },
    {
      icon: '🔒',
      h: 'No password to remember',
      p: "We use secure magic links instead of passwords. Just click and you're in.",
    },
  ],
} as const;
