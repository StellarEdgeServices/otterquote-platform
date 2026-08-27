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
  STRIPE_PK_TEST: 'pk_test_51TCI2O0AJRnqIYPUgKku8lRifucMiKIBTdu8hkmBLjjXVR73eggMnqVuPPtlZF8thfGypv8UShBoLsoIgY4ELfRP009TrgSIxo',

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

function _oqCreateSupabaseClient() {
  if (sb) return true;
  if (typeof supabase === 'undefined') return false;
  sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON, { auth: { storage: window.OtterQuoteCookieStorage } });
  return true;
}

// Bridge 2026-08-26 (P0): this used to be a bare `if (typeof supabase !== ...)`
// with no retry, which silently did nothing on any page that loads the Supabase
// UMD bundle AFTER this file. ELEVEN pages do exactly that — login.html, all five
// partner signup pages, and three ref-* referral landing pages among them. On
// those pages `sb` stayed undefined forever, so every Auth.* call died at its own
// `if (!sb) throw new Error('Supabase not initialized')` guard BEFORE any network
// request. That is why homeowner login reported "OAuth doesn't work, password
// doesn't work, can't get in": the page could not construct a client at all.
// The tell was that the failing clicks produced ZERO rows in the Supabase auth
// logs — not an error, an absence.
//
// Retrying on DOMContentLoaded is the mechanism rather than the patch: every
// synchronous <script src> on the page has executed by then, whatever order the
// author put them in, and no user can click before that point. The page-level
// script-order bug is still worth fixing on its own, but this makes it stop
// being able to take auth down.
// ── gh-1292: whenReady(cb) ──
// The DOMContentLoaded retry above only covers code that runs AFTER
// DOMContentLoaded fires. It does nothing for code that runs at PARSE TIME
// (inline <script> blocks executed synchronously as the HTML parser reaches
// them) — that code has already run and seen `sb` undefined by the time
// DOMContentLoaded fires, and nothing ever re-runs it. That is the actual
// defect behind #1292 (Google partner signup, recruit-code attribution,
// parse-time session reads reporting a false "signed out").
//
// whenReady(cb) works from any point — parse time, post-DOMContentLoaded,
// or never-quite-loaded. cb(sb) fires exactly once, synchronously if `sb`
// already exists, otherwise as soon as it's created. If the Supabase UMD
// bundle never loads at all (network failure, blocked script), cb(null)
// fires after a bounded ~20s poll instead of hanging forever.
var _oqReadyCallbacks = [];

function _oqFlushReadyCallbacks(result) {
  if (_oqReadyCallbacks.length === 0) return;
  var cbs = _oqReadyCallbacks;
  _oqReadyCallbacks = [];
  cbs.forEach(function (cb) {
    try { cb(result); } catch (e) { console.error('[config] whenReady callback threw:', e); }
  });
}

CONFIG.whenReady = function (cb) {
  if (_oqCreateSupabaseClient()) {
    cb(sb);
    return;
  }
  _oqReadyCallbacks.push(cb);
};

if (!_oqCreateSupabaseClient() && typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', function () {
    if (_oqCreateSupabaseClient()) {
      _oqFlushReadyCallbacks(sb);
    } else {
      console.error('[config] Supabase library never loaded — authentication is unavailable on this page.');
    }
  });

  // Also poll on a short interval. DOMContentLoaded only fires once and only
  // covers a synchronous script-ordering bug; a `defer`/`async` Supabase UMD
  // tag can resolve AFTER DOMContentLoaded already fired past the listener
  // above. Polling is what actually catches that case.
  var _oqReadyPollCount = 0;
  var _oqReadyPollId = setInterval(function () {
    _oqReadyPollCount++;
    if (_oqCreateSupabaseClient()) {
      clearInterval(_oqReadyPollId);
      _oqFlushReadyCallbacks(sb);
    } else if (_oqReadyPollCount > 100) { // ~20s at 200ms
      clearInterval(_oqReadyPollId);
      console.error('[config] Supabase library never loaded after 20s — whenReady callbacks resolving with null.');
      _oqFlushReadyCallbacks(null);
    }
  }, 200);
}
