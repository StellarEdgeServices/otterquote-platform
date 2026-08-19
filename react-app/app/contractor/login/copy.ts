/**
 * Contractor-login page copy — D-211 P4 (port of static contractor-login.html)
 *
 * SINGLE SOURCE OF TRUTH for all user-facing strings on /contractor/login.
 * page.tsx renders ONLY from this object; the co-located parity test asserts
 * these constants byte-for-byte against the static contractor-login.html.
 *
 * ⚠️ D-244 VERBATIM-LOCKED LOGIN-PATH COPY ⚠️
 * The `sent*` and `resend*` strings below are the canonical login-path copy.
 * They are privacy-preserving by design ("If an account exists…") and MUST NOT
 * be changed without a security review + Dustin sign-off (D-244 is Tier-3).
 * Any edit here trips the parity test in __tests__/contractor-login.test.tsx.
 *
 * NOTE: contractor-login.html has its OWN wording — it is NOT identical to
 * login.html (P3). Ported independently from contractor-login.html @ main.
 */

export const CONTRACTOR_LOGIN_COPY = {
  // ── Document / SEO ──
  pageTitle: 'Contractor Login — Otter Quotes',

  // ── Form ──
  title: 'Contractor Login',
  subtitle:
    'Sign in to your Otter Quotes contractor portal to view opportunities, manage bids, and track your projects.',
  googleButton: 'Sign in with Google',
  googleRedirecting: 'Redirecting to Google…',
  oauthDivider: 'or continue with email',
  emailLabel: 'Business Email',
  emailPlaceholder: 'you@yourcompany.com',
  emailHint: "We'll send you a secure login link — no password needed.",
  submitButton: 'Send Login Link',

  // ── Errors ──
  errorInvalidEmail: 'Please enter a valid email address.',
  // Static composes: 'Something went wrong. Please try again or email us at ' + CONFIG.SUPPORT_EMAIL
  errorGenericPrefix: 'Something went wrong. Please try again or email us at ',
  supportEmail: 'support@otterquote.com',
  errorGoogle: 'Google sign-in failed. Please try again or use email below.',

  // ── D-244 VERBATIM-LOCKED (magic-link sent state) ──
  sentHeading: 'Check Your Email',
  sentBody: 'If an account exists, we sent a link.',
  sentExpiry: 'If you receive a link, it will expire in 1 hour.',
  sentResend: "Didn't get it? Send again",
  resendAlert: 'If an account exists, we sent a link.',
  resendErrorAlert: 'Could not resend. Please try again in a moment.',

  // ── Cross-role sibling link (D-242) ──
  homeownerPrefix: 'Are you a homeowner?',
  homeownerLink: 'Sign in to your account',

  // ── Join CTA ──
  joinDivider: 'or',
  joinPrompt: 'New to Otter Quotes? Apply to join our contractor network.',
  joinButton: 'Apply to Join',

  // ── Right benefits panel ──
  benefitsHeading:
    'Otter Quotes is not a referral service. We are your marketing department and sales force all rolled into one!',
  benefits: [
    {
      icon: '📜',
      h: 'Only pay for signed contracts.',
      p: 'Customers sign YOUR contract on our platform. You get a fully scoped project — measurements, materials, and a signed contract — ready to install. Just call the customer and schedule the work.',
    },
    {
      icon: '🎨',
      h: 'Project details settled before you show up.',
      p: 'You set your preferred materials. Homeowners pick their colors from your options. The scope is locked before anyone signs — no back-and-forth after the contract is executed.',
    },
    {
      icon: '🆔',
      h: 'No cost to join.',
      p: 'Just upload your insurance, license, and contract forms. You pay nothing until you get your first customer. Our simple process takes less than 15 minutes.',
    },
    {
      icon: '📋',
      h: 'Choose what jobs you want to bid on.',
      p: "You see the homeowner's scope of work and details and set your own price.",
    },
    {
      icon: '👋',
      h: 'No sales reps needed!',
      p: "Don't want the headaches of a sales force? These sales are already closed for you. No truck, gas, or referral fees needed.",
    },
  ],
} as const;
