// gh-1619: GA4 host gate.
//
// The production gtag was loading unconditionally on every host that served
// these pages -- staging (staging--jade-alpaca-b82b5e.netlify.app), branch
// deploy previews, and localhost/127.0.0.1 -- alongside production
// (otterquote.com / app.otterquote.com). A live GA4 read on 2026-09-04
// (hostName dimension, last 28 days, unfiltered) showed staging alone
// carrying 17x production session volume and 127.0.0.1 carrying 2.5x
// production; production was 7.6% of the entire property. Every conversion
// rate, funnel denominator, and traffic read downstream of this GA4
// property was wrong by roughly that same factor.
//
// This file is the single point where the GA4 library is allowed to load.
// It must be the ONLY place gtag.js is requested -- do not add a second
// <script async src="https://www.googletagmanager.com/gtag/js?..."> tag
// anywhere; a per-file variant of this gate is how the bug recurs (see the
// issue). Every page that fires gtag events includes this file first, then
// makes its own gtag('config', ...) call.
//
// Microsoft Clarity (project wwr7qlk8g5) is carried by the SAME gate, per the
// CTO ruling on gh-1619: it had the same robot problem on the same pages for
// the same reason, and its 30-day retention means pollution cannot be
// re-derived away later. The Clarity <script> is likewise never injected
// off-allowlist. scripts/check-gtag-single-source.py fails CI if either
// loader appears anywhere but here.
//
// Fail-closed by design: an unrecognised hostname is far more likely to be
// a new preview/staging surface than a new production domain, so it never
// loads the library. Extending the allowlist is a deliberate, reviewed
// decision, not a default.
(function () {
  var ALLOWED_HOSTS = ['otterquote.com', 'www.otterquote.com', 'app.otterquote.com'];
  var MEASUREMENT_ID = 'G-D1Y1TLGEFY';
  var CLARITY_PROJECT_ID = 'wwr7qlk8g5';

  // dataLayer/gtag are defined unconditionally so every page's existing
  // gtag('event', ...) / gtag('config', ...) calls keep working (as harmless
  // queued-but-never-sent pushes) even when the host is not allowed --
  // callers do not need host-awareness of their own.
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());

  if (ALLOWED_HOSTS.indexOf(window.location.hostname) === -1) {
    return; // not a recognised production host -- the GA4 library never loads
  }

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
  document.head.appendChild(s);

  // gh-1931 (round 2): Supabase's implicit OAuth flow appends a live
  // access_token/refresh_token pair to whatever redirect URL the caller
  // passed -- js/auth.js's sendMagicLink/signInWithGoogle/signUpWithPassword/
  // sendPasswordReset all take an arbitrary redirectTo, so this was never a
  // property of one page. Round 1 of this fix excluded only
  // /auth-callback.html by path; independent review on the PR measured five
  // MORE pages still leaking the same way (dashboard.html,
  // contractor-pre-approval.html, partner-dashboard.html,
  // login.html?recovery=1, partner-insurance.html?g=1 -- plus
  // partner-login.html?recovery=1, sendPasswordReset's own default, found
  // re-deriving this list), and showed the path guard is bypassed by the
  // extensionless Pretty-URLs twin (/auth-callback with no .html). A path
  // list can never be complete -- any future signInWithGoogle('/new.html')
  // silently reopens it -- so this gates on what actually makes a URL
  // dangerous: a live credential in the FRAGMENT. access_token,
  // refresh_token and provider_token are Supabase's own implicit-flow
  // parameter names and never appear outside that fragment, so a raw
  // substring check on window.location.hash carries no collateral risk --
  // a URL fragment is never a marketing/referral parameter.
  var hash = window.location.hash;
  var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
    hash.indexOf('refresh_token') !== -1 ||
    hash.indexOf('provider_token') !== -1;

  // gh-1931 (round 3): round 2 also matched window.location.search against
  // 'code=' with the same indexOf substring check. That leg was wrong on two
  // counts, both found by independent review and confirmed by reading this
  // repo directly:
  // (1) `code` is this site's OWN referral-partner query parameter --
  //     ref.html/ref-insurance.html/ref-re.html/ref-inspector.html read it
  //     to look up an agent, netlify/edge-functions/ref-redirect.ts 301s
  //     /ref/:code onto /ref.html?code=:code, and partner-dashboard.html
  //     builds recruit.html and partner-profile.html links the same way --
  //     so a substring match also fired on unrelated params whose name only
  //     *contains* "code=" (promocode=, zipcode=, discount_code=,
  //     error_code=, qrcode=). Left unfixed, that silently switched Clarity
  //     off across the entire referral-partner acquisition funnel, the one
  //     growth channel this company is actively investing in -- with no
  //     visible symptom (Clarity going quiet on a page looks the same as
  //     Clarity never having been asked to load there).
  // (2) It was also dead code: js/supabase-client.js sets no flowType, and
  //     the pinned supabase-js 2.112.4 (read out of the pinned bundle)
  //     defaults to flowType: 'implicit'. PKCE's ?code= callback is not
  //     enabled anywhere in this repo today (zero hits for flowType, zero
  //     for verifyOtp/token_hash) -- so the leg protected a flow that does
  //     not run, at the cost of a flow that does.
  // This block stays DORMANT until PKCE is actually turned on (flowType:
  // 'pkce' -- the durable fix for gh-1931, tracked as its own CTO Tier A
  // decision on that issue, not decided here). When it is, this needs an
  // exact query-PARAMETER match, never a substring one, and it must stay
  // scoped to only the pages Supabase's own OAuth/magic-link/reset flow can
  // actually land a user on -- never site-wide -- so it can never collide
  // with ref.html's/recruit.html's/partner-profile.html's own ?code=, which
  // those pages keep unconditionally. PKCE_CALLBACK_PATHS is exactly the
  // set of pages the round-1/round-2 reviews and this repo's own
  // js/auth.js call graph identified as real or defensive landing targets
  // for that flow -- not a guess, and not "every page on the site".
  var PKCE_CALLBACK_PATHS = [
    '/auth-callback.html',
    '/dashboard.html',
    '/contractor-pre-approval.html',
    '/partner-dashboard.html',
    '/login.html',
    '/partner-login.html',
    '/partner-insurance.html'
  ];
  if (!urlHasAuthToken && PKCE_CALLBACK_PATHS.indexOf(window.location.pathname) !== -1) {
    try {
      urlHasAuthToken = new URLSearchParams(window.location.search).has('code');
    } catch (e) {
      // URLSearchParams is unsupported or search is malformed -- fail closed
      // is not available here (that would be the opposite mistake round 3
      // fixes), so simply leave urlHasAuthToken as the fragment check found.
    }
  }

  if (urlHasAuthToken) {
    return; // a live Supabase credential is in this URL; Clarity never loads.
  }

  // Microsoft Clarity -- the vendor snippet, verbatim apart from living
  // behind the allowlist check above. Reached only on a production host,
  // and never on a URL carrying a live auth credential (see gh-1931 above).
  (function (c, l, a, r, i, t, y) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
    t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
    y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
  })(window, document, 'clarity', 'script', CLARITY_PROJECT_ID);
})();
