// D-221 soak cycle 2 — 2026-05-08T15:13:25Z
/**
 * OtterQuote — Global Configuration
 * All environment-specific values in one place.
 */

var CONFIG = {
  // ── Supabase ──
  SUPABASE_URL:  'https://yeszghaspzwwstvsrioa.supabase.co',
  SUPABASE_ANON: 'sb_publishable_mKmYIsRMc6dCG8ZrGGbyyw_l_MOTwZP',

  // ── Google Analytics 4 ──
  GA4_ID: 'G-D1Y1TLGEFY',

  // ── Mailgun (inbound email parsing) ──
  MAILGUN_DOMAIN:  'sandboxd2b099fad357409b845e5f4c5e8bd74e.mailgun.org',
  MAILGUN_API_URL: 'https://api.mailgun.net',
  // gh-1135: INGEST_EMAIL_DOMAIN removed — claims.otterquote.com was NXDOMAIN
  // with zero inbound routes, so every generated docs-*@claims.otterquote.com
  // address silently hard-bounced adjuster replies. js/services.js now sets
  // Reply-To to the requesting homeowner's own email instead. The receiving
  // half (an inbound-parse Edge Function) is tracked as a separate,
  // explicitly non-urgent feature issue — if it's ever built, this constant
  // comes back then, not before.
  // NOTE: MAILGUN_API_KEY is server-side only (Edge Functions), never exposed in frontend

  // ── Twilio (SMS notifications) ──
  TWILIO_PHONE:  '18448753412',
  // NOTE: TWILIO_SID and TWILIO_TOKEN are server-side only (Edge Functions)

  // ── Stripe (payments: Hover fees, deductible escrow, contractor platform fees) ──
  STRIPE_PK_LIVE: 'pk_live_51TCI2O0AJRnqIYPU4ybaUmt2FRxihUu4kMKXvjnrvfsWRHyoi8ptkVuyKsDs3Zq4dMrGniPGg5BxtAmZfukah5aI00K31rnCbk',

  // Bridge 2026-08-26: there was no test publishable key at all, and that made
  // an end-to-end payment test impossible to run safely.
  //
  //   - On PRODUCTION the browser uses pk_live and create-payment-intent uses
  //     STRIPE_SECRET_KEY. A walk-through moves REAL money.
  //   - On STAGING create-payment-intent already switches to
  //     STRIPE_SECRET_KEY_TEST (it detects "staging--" / "app-staging." in the
  //     request Origin), but the browser kept sending pk_live — so the modes
  //     disagreed and the PaymentIntent could never be confirmed.
  //
  // Fill this in with the publishable TEST key from the Stripe dashboard
  // (pk_test_...). It is not a secret — publishable keys are designed to ship
  // in the client. Until it is set, staging deliberately FAILS LOUDLY below
  // rather than quietly falling back to the live key.
  STRIPE_PK_TEST: '',

  // NOTE: STRIPE_SECRET_KEY is server-side only (Edge Functions)

  // ── DocuSign (e-signatures) ──
  DOCUSIGN_INTEGRATION_KEY: '43f4a7d5-f1bf-45ec-8a97-264e3d473e42',
  DOCUSIGN_ACCOUNT_ID:      '0b57b777-5c6e-4650-80d3-14152257ca82',
  DOCUSIGN_BASE_URI:        'https://na3.docusign.net',
  // NOTE: DOCUSIGN_USER_ID is server-side only (Edge Functions)

  // ── Hover ──
  // Pending API partner approval
  HOVER_API_KEY:  'PLACEHOLDER_hover_api_key',
  HOVER_API_URL:  'https://api.hover.to/v1',

  // ── Platform Settings ──
  PLATFORM_FEE_PERCENT: 5,         // Starting at 5%, target 10%, test 15%
  MAX_CONTRACTORS_PER_LEAD: 6,     // D-030
  CONTRACTOR_CONTACT_HOURS: 48,    // D-024
  CANCELLATION_DAYS_BEFORE: 3,     // D-041

  // ── Site Info ──
  SITE_NAME: 'Otter Quotes',
  // #562: staging (netlify branch deploys) must redirect magic-link/OAuth
  // callbacks back to itself, not to production — otherwise a session
  // started on staging completes on otterquote.com with no cookie to
  // follow it (staging cookies are netlify-host-scoped, D-212 domain
  // cookies are never set there). Production keeps the literal constant
  // unchanged. Database stays shared (SUPABASE_URL untouched) — see #696
  // for that separate, larger decision.
  SITE_URL: (typeof window !== 'undefined' && window.location.hostname.includes('staging'))
    ? window.location.origin
    : 'https://otterquote.com',
  IS_STAGING: (typeof window !== 'undefined' && window.location.hostname.includes('staging')),
  SUPPORT_EMAIL: 'support@otterquote.com',

  // ── Demo Mode ──
  // When true, pages show sample data without requiring Supabase auth.
  // Set to false before production launch.
  DEMO_MODE: false,

  // ── Launch Gate ──
  // Set to true to open homeowner and partner pages. False keeps coming-soon.html active.
  HOMEOWNER_LAUNCH_ENABLED: true,
};

// ── Stripe publishable key, mode-matched to the Edge Functions ──
// Defined after the object literal because it reads CONFIG.IS_STAGING.
// Every consumer reads CONFIG.STRIPE_PK, unchanged — only its value moves.
Object.defineProperty(CONFIG, 'STRIPE_PK', {
  enumerable: true,
  get: function () {
    if (!CONFIG.IS_STAGING) return CONFIG.STRIPE_PK_LIVE;
    if (CONFIG.STRIPE_PK_TEST) return CONFIG.STRIPE_PK_TEST;
    // Refuse to hand a live publishable key to a staging page. Returning
    // empty makes every consumer's existing `if (!CONFIG.STRIPE_PK)` guard
    // fire with a visible message instead of silently charging a real card.
    console.error('[config] STRIPE_PK_TEST is not set. Staging will not load Stripe ' +
                  'rather than fall back to the live key. Set it in js/config.js.');
    return '';
  }
});

// ── Initialize Supabase Client ──
var sb; // var (not let) — allows safe early-load in <head> of gated pages alongside redirect guard
if (typeof supabase !== 'undefined') {
  sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON, { auth: { storage: window.OtterQuoteCookieStorage } });
}
