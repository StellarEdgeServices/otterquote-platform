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
//
// gh-1964: Clarity page-set gate (default-deny).
//
// The host gate above stops Clarity from loading on the WRONG HOST. It says
// nothing about the wrong PAGE: Clarity session replay records DOM and
// input, and this file was included -- and its host check passed -- on 9 of
// 12 admin-*.html pages plus contractor-profile.html, all of them requiring
// an authenticated admin or contractor session, with no masking configured.
// contractor-profile.html renders a live Supabase signed URL into a <video
// src> at ~line 1810 -- a bearer credential -- which a session recorder then
// captures. scripts/check-gtag-single-source.py enforces WHERE the loader
// lives; it never checked WHICH PAGES include it. That is the gap this gate
// closes, mirroring the allowlist pattern already proven on the app side at
// react-app/app/components/MetaPixelGate.tsx:70 (ALLOWED_PATHS).
//
// This is DEFAULT-DENY, for Clarity only -- GA4's behaviour above is
// unchanged. CLARITY_ALLOWED_PATHS is the complete set of unauthenticated
// marketing/funnel pages this repo's own HTML was read to identify (see
// scripts/check-clarity-page-gate.py for the enumeration and the
// authenticated/unauthenticated/session-touching evidence behind each page's
// classification). A page missing from this list fails closed: Clarity
// simply never loads there, including on a brand-new page nobody has added
// yet. Extending this list is a deliberate, reviewed decision, exactly like
// ALLOWED_HOSTS above -- never a default.
//
// PR #1978 refuter review (cto32-review-pr1978-20260915.md, defect D1):
// '/contractor-pre-approval' was on this list even though
// contractor-pre-approval.html requires a live session -- it calls
// `window.Auth.getSession()`, loads the signed-in contractor's own
// `contractors` row, prefills their phone/trades/service area, and accepts
// insurance/license document uploads. It was misclassified PUBLIC because
// its guard (`if (!session) { ...; showPanel('error'); return; }`) did not
// match any AUTH_MARKERS pattern at the time. It is removed below, and
// scripts/check-clarity-page-gate.py's classifier is now fail-closed at the
// session layer, not just the explicit-auth-gate layer (see that script's
// module docstring).
//
// gh-1981: '/login' was on this list via a SESSION_AWARE_PUBLIC exception
// ("only redirects an already-signed-in visitor to their dashboard").
// That exception was wrong about what the page does: login.html's
// routeOrExplainNonHomeowner() renders "You're already signed in as
// <role> (<the visitor's own email>)" into the DOM via innerHTML for any
// signed-in contractor/partner, WITH an offer to stay on the page and
// switch accounts instead of redirecting -- session-scoped account data
// (an email address) shown to the very visitor Clarity is recording, not
// just an anonymous one. It is removed below and from
// scripts/check-clarity-page-gate.py's SESSION_AWARE_PUBLIC.
(function () {
  var ALLOWED_HOSTS = ['otterquote.com', 'www.otterquote.com', 'app.otterquote.com'];
  var MEASUREMENT_ID = 'G-D1Y1TLGEFY';
  var CLARITY_PROJECT_ID = 'wwr7qlk8g5';

  // gh-1964: the public, unauthenticated pages Clarity is allowed to record.
  // Entries are normalised paths (see normalizeClarityPath below): no
  // trailing slash (except root), no .html extension, and directory-index
  // pages collapse to their directory ("/blog/index.html" -> "/blog"). Every
  // entry here was derived from this repo's own HTML -- a page is on this
  // list only because reading its markup and scripts found no
  // Auth.requireAuth()/admin-email/getSession-redirect gate on it, never
  // because of what its filename suggests. A page that DOES touch a session
  // (Auth.getUser()/hasPartnerSession() bouncing an already-signed-in
  // visitor, an OAuth-initiation call, etc.) but has been read and judged
  // safe is listed with its one-line reason in
  // scripts/check-clarity-page-gate.py's SESSION_AWARE_PUBLIC set, not
  // silently assumed here. auth-callback.html is deliberately left OFF this
  // list even though it carries no such gate itself: it is the OAuth/magic-
  // link landing target that can carry a live token in the URL fragment, the
  // gh-1931 fragment check below already blocks Clarity there whenever a
  // token is actually present, and keeping it off the allowlist is defense
  // in depth for the token-absent case (a stale or reloaded tab).
  // gh-1939 SCOPE EXTENSION (Dustin, 2026-09-16, #1939 comment 5691693161,
  // verbatim selected option: "Funnel to bid accept (Recommended)"): the
  // homeowner funnel pages up to bid acceptance are added below even though
  // they are AUTHENTICATED. Each one is listed in
  // scripts/check-clarity-page-gate.py's RULED_AUTHENTICATED_ALLOWED with the
  // ruling, and that check FAILS unless the page's <body> carries
  // data-clarity-mask="true" (all text and inputs masked in replay). Still
  // excluded by the same ruling: contract-signing, auth-callback, admin-*,
  // contractor-* and partner-* authenticated pages. The gh-1931 fragment
  // token check below runs on every one of them.
  var CLARITY_ALLOWED_PATHS = [
    '/',
    '/blog',
    '/blog/aerial-roof-measurement-reports',
    '/blog/does-homeowners-insurance-cover-roof-damage',
    '/blog/hail-damage-roof-inspection-first-72-hours',
    '/blog/hail-vs-wind-roof-damage',
    '/blog/how-to-negotiate-better-roof-repair-insurance-claim',
    '/blog/public-adjuster-vs-diy-roof-claim',
    '/blog/rcv-vs-acv-roof-insurance',
    '/blog/roof-shingle-warranty-tiers-explained',
    '/blog/roofing-estimate-red-flags',
    '/blog/storm-chaser-roofing-scams',
    '/blog/what-is-recoverable-depreciation-roofing',
    '/blog/what-is-scope-of-loss-roofing',
    '/blog/what-to-do-after-storm-damages-roof',
    '/blog/when-not-to-file-roof-insurance-claim',
    '/blog/why-roofers-quote-different-prices',
    '/bids',
    '/coming-soon',
    '/contractor-about',
    '/contractor-agreement',
    '/contractor-faq',
    '/contractor-how-it-works',
    '/contractor-join',
    '/contractor-login',
    '/contractors',
    '/dashboard',
    '/faq',
    '/guides',
    '/guides/how-to-choose-contractor',
    '/guides/how-to-file-property-damage-claim',
    '/guides/how-to-negotiate-with-insurer',
    '/guides/how-to-read-contractor-estimate',
    '/how-it-works',
    '/landing',
    '/onboarding-demo',
    '/oq-voice-ai',
    '/partner-adjusters',
    '/partner-agreement',
    '/partner-app',
    '/partner-app-install-android',
    '/partner-app-install-ios',
    '/partner-inspectors',
    '/partner-insurance',
    '/partner-insurance-fees',
    '/partner-insurance-how-it-works',
    '/partner-insurance-why',
    '/partner-login',
    '/partner-other',
    '/partner-profile',
    '/partner-re',
    '/privacy',
    '/project-info-acv',
    '/project-info-cash',
    '/project-info-rcv',
    '/recruit',
    '/ref',
    '/ref-inspector',
    '/ref-insurance',
    '/ref-re',
    '/repair-intake',
    '/stellar-edge',
    '/terms',
    '/tools',
    '/tools-crm',
    '/tools-online-presence',
    '/tools-voice-ai'
  ];

  // Normalises a pathname so a Pretty-URL twin matches its .html original:
  // trailing slash stripped (root "/" kept as-is), ".html" extension
  // stripped, and a directory's own "/index" collapses onto the directory.
  function normalizeClarityPath(pathname) {
    var p = pathname;
    if (p.length > 1 && p.charAt(p.length - 1) === '/') {
      p = p.slice(0, -1);
    }
    if (p.slice(-5) === '.html') {
      p = p.slice(0, -5);
    }
    if (p === '') {
      p = '/';
    }
    if (p.slice(-6) === '/index') {
      p = p.slice(0, -6);
      if (p === '') {
        p = '/';
      }
    }
    return p;
  }

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

  // gh-1964: default-deny page-set gate, Clarity only. GA4 above already
  // loaded unconditionally on any allowed host; Clarity additionally
  // requires the current page to be on the public allowlist above. A page
  // that is missing from CLARITY_ALLOWED_PATHS -- including every
  // admin-*.html page, contractor-profile.html and contractor-pre-
  // approval.html -- fails closed here and never reaches the fragment check
  // or the vendor snippet below.
  if (CLARITY_ALLOWED_PATHS.indexOf(normalizeClarityPath(window.location.pathname)) === -1) {
    return; // not a recognised public page -- Clarity never loads
  }

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
  //
  // gh-1964: kept as-is (PR #1947) on top of the page-set gate above -- the
  // page-set gate stops Clarity on authenticated PAGES; this stops it on any
  // allowlisted page that happens to be carrying a live credential in its
  // URL right now (e.g. login.html mid magic-link exchange).
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
  // gh-1939 review finding 4: compare NORMALISED paths -- /dashboard is now
  // allowlisted, and its Pretty-URL twin must not skip this leg.
  var pkceNormalised = [];
  for (var pk = 0; pk < PKCE_CALLBACK_PATHS.length; pk++) {
    pkceNormalised.push(normalizeClarityPath(PKCE_CALLBACK_PATHS[pk]));
  }
  if (!urlHasAuthToken && pkceNormalised.indexOf(normalizeClarityPath(window.location.pathname)) !== -1) {
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

  // gh-1939 review finding 1: data-clarity-mask hides a field in replay, but
  // Clarity's fraud checksum still uploads a 28-bit hash of any typed value of
  // 5+ characters at the Text/TextImage privacy levels -- brute-forceable for
  // a phone number or ZIP. Clarity drops a field to its Exclude level (value
  // AND checksum blanked) when an attribute value contains "secret", so every
  // input/textarea/select on any page Clarity loads on is tagged, including
  // ones rendered later. The observer is registered here, before the vendor
  // snippet, so it runs ahead of Clarity's own on every mutation batch.
  (function () {
    var SEL = 'input, textarea, select';
    function tag(el) {
      if (el && el.setAttribute && !el.hasAttribute('data-oq-privacy')) {
        el.setAttribute('data-oq-privacy', 'secret');
      }
    }
    function tagAll(root) {
      if (!root || root.nodeType !== 1) return;
      if (root.matches && root.matches(SEL)) tag(root);
      var nodes = root.querySelectorAll ? root.querySelectorAll(SEL) : [];
      for (var i = 0; i < nodes.length; i++) tag(nodes[i]);
    }
    try {
      new MutationObserver(function (muts) {
        for (var m = 0; m < muts.length; m++) {
          var added = muts[m].addedNodes;
          for (var n = 0; n < added.length; n++) tagAll(added[n]);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* no MutationObserver -- DOMContentLoaded pass below still runs */ }
    tagAll(document.documentElement);
    document.addEventListener('DOMContentLoaded', function () { tagAll(document.documentElement); });
  })();

  // Microsoft Clarity -- the vendor snippet, verbatim apart from living
  // behind the allowlist checks above. Reached only on a production host,
  // only on an allowlisted public page (gh-1964), and never on a URL
  // carrying a live auth credential (see gh-1931 above).
  (function (c, l, a, r, i, t, y) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
    t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
    y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
  })(window, document, 'clarity', 'script', CLARITY_PROJECT_ID);
})();
