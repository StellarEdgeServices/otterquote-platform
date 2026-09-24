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
//
// gh-1981 fix round 1 (PR #1996 review, comment 5698663751; Ben's ruling,
// comment 5698879235): the #1981 SESSION_AWARE_PUBLIC re-audit above missed
// '/partner-profile'. Its reason claimed Auth.getUser() "resolves only the
// signed-in partner's own PUBLIC referral code ... rendered as a public
// referral link". Runtime measurement showed otherwise: with no ?code= in
// the URL, a signed-in partner's own full profile card -- name, company,
// service area, photo, bio -- is rendered via card.innerHTML
// (partner-profile.html:238-247, renderProfile() at :209), and Clarity
// loaded (1 request) while it did. Ben's ruling: this counts as account
// data ("a partner's own identity rendered because they are signed in"),
// removal is the R-134-protective shape, and a bare ?code= profile view has
// no measurement value to Sloane's funnel -- a conditional ?code=-only skip
// was considered and rejected. Removed below and from
// scripts/check-clarity-page-gate.py's SESSION_AWARE_PUBLIC.
(function () {
  var ALLOWED_HOSTS = ['otterquote.com', 'www.otterquote.com', 'app.otterquote.com'];
  var MEASUREMENT_ID = 'G-D1Y1TLGEFY';
  var CLARITY_PROJECT_ID = 'wwr7qlk8g5';

  // gh-2063 fix round 2 (PR #2065 review, item 4): shared by the GA4 and
  // Clarity vendor-script insertions below (js/meta-pixel-gate.js carries
  // its own copy for fbevents.js -- these two files intentionally do not
  // share a module today, see this file's own "single point" docstring
  // above about not adding cross-file coupling lightly). Runs `fn` on
  // whichever comes first: the browser going idle (capped at 1500ms via
  // requestIdleCallback's own timeout option), a hard 1500ms timer where
  // requestIdleCallback is unsupported, or the visitor's first
  // pointerdown/keydown/scroll/touchstart. Exactly one of those wins; the
  // rest are torn down immediately so `fn` never runs twice.
  // gh-2121 S05 (CEO RUN 67): the timeout below used to be a hard-coded
  // 1500. It now reads window.__OQ_ANALYTICS_DEFER_MS when start.html (or
  // any other including page) has set it, falling back to 1500 exactly as
  // before when it has not -- every page/arm that never sets this global is
  // byte-for-byte unaffected. start.html sets it to ~3500 for Arm F only
  // (see that file's own gh-2121 comment above its gate-loader script),
  // since Arm F is where all paid Meta traffic lands (#2121) and the
  // 1500ms cap left gtag.js/fbevents.js/clarity.js executing well inside
  // the window Lighthouse scores LCP/TTI against. This is a timing knob
  // only -- ALLOWED_HOSTS, CLARITY_ALLOWED_PATHS, the oqInternal()
  // fail-closed check and every other gate below are unchanged.
  function _oqAnalyticsDeferMs() {
    return (typeof window.__OQ_ANALYTICS_DEFER_MS === 'number') ? window.__OQ_ANALYTICS_DEFER_MS : 1500;
  }
  // gh-2121 S05: requestIdleCallback returns the instant the main thread
  // goes idle, which on a light page can be well under a second regardless
  // of the timeout passed -- measured directly (tests/gh2121-s05-defer-
  // analytics.mjs) at ~0.3-0.7s even with the timeout raised to 3500. The
  // brief's fix is a FIXED delay ("about 3-4s") racing first interaction,
  // not "idle, capped at 3-4s" -- those are different triggers, and idle
  // firing early is exactly what left gtag.js/fbevents.js/clarity.js still
  // landing inside Lighthouse's LCP/TTI window in production. When
  // start.html sets window.__OQ_ANALYTICS_FORCE_TIMER (Arm F only), this
  // skips requestIdleCallback entirely and uses a plain timer for the
  // non-interaction leg, same as the else branch below already does when
  // requestIdleCallback is unsupported.
  function _oqAnalyticsForceTimer() {
    return window.__OQ_ANALYTICS_FORCE_TIMER === true;
  }
  function _oqLoadOnIdleOrInteraction(fn) {
    var fired = false;
    var idleHandle = null;
    var timeoutHandle = null;
    var EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'];
    function teardown() {
      for (var i = 0; i < EVENTS.length; i++) {
        window.removeEventListener(EVENTS[i], run);
      }
      if (idleHandle !== null && window.cancelIdleCallback) { window.cancelIdleCallback(idleHandle); }
      if (timeoutHandle !== null) { clearTimeout(timeoutHandle); }
    }
    function run() {
      if (fired) return;
      fired = true;
      teardown();
      fn();
    }
    for (var i = 0; i < EVENTS.length; i++) {
      window.addEventListener(EVENTS[i], run, { passive: true, once: true });
    }
    var deferMs = _oqAnalyticsDeferMs();
    if (window.requestIdleCallback && !_oqAnalyticsForceTimer()) {
      idleHandle = window.requestIdleCallback(run, { timeout: deferMs });
    } else {
      timeoutHandle = setTimeout(run, deferMs);
    }
  }

  // gh-2064 round 2: the opt-out used to live ONLY in js/internal-traffic.js,
  // which was included on 10 of the 99 pages that load this gate -- on the
  // other 89 (including start.html and index.html), window.OQ_INTERNAL was
  // simply never set, so `if (window.OQ_INTERNAL) return;` below never
  // fired and this gate could not be told to stand down. That is exactly
  // what the round-1 review failed the PR for: internal-traffic.js is now
  // a documentation/early-set convenience only, and every gate reads
  // and writes the signal itself so nothing depends on that other file
  // being present on the page at all. Same cookie/param contract as
  // internal-traffic.js (kept in sync deliberately: same name, same
  // Max-Age, same Domain rule), wrapped in try/catch so a hostile or
  // unsupported document.cookie / URLSearchParams never breaks tag loading
  // for a real visitor.
  function oqInternal() {
    try {
      var params = null;
      try {
        params = new URLSearchParams(window.location.search);
      } catch (e) {
        params = null;
      }
      var queryFlag = !!(params && params.get('oq_internal') === '1');

      var cookieMatch = document.cookie.match(/(?:^|; )oq_internal=([^;]*)/);
      var cookieFlag = !!(cookieMatch && decodeURIComponent(cookieMatch[1]) === '1');

      if (queryFlag && !cookieFlag) {
        var oneYear = 60 * 60 * 24 * 365;
        var domainAttr = '';
        // Only a real otterquote.com host accepts a .otterquote.com-scoped
        // cookie -- on localhost/preview/test hosts this attribute would be
        // rejected outright and silently fail to set (see
        // js/internal-traffic.js for the same rule).
        if (/(^|\.)otterquote\.com$/.test(window.location.hostname)) {
          domainAttr = '; Domain=.otterquote.com';
        }
        document.cookie = 'oq_internal=1; Max-Age=' + oneYear + '; Path=/' +
          domainAttr + '; SameSite=Lax';
      }

      var isInternal = queryFlag || cookieFlag;
      window.OQ_INTERNAL = isInternal;
      return isInternal;
    } catch (e) {
      // Fail closed on "internal" detection, i.e. never let a thrown error
      // here suppress it -- but if window.OQ_INTERNAL is already true
      // (e.g. set earlier by js/internal-traffic.js), respect that.
      return !!window.OQ_INTERNAL;
    }
  }

  // Runs immediately, before the gtag stub below, so window.OQ_INTERNAL is
  // already correct by the time any gtag('js'|'config'|'event', ...) call
  // reaches the stub -- not just at the early-return check further down.
  var OQ_INTERNAL_FLAG = oqInternal();

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
    '/start',
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
  // gh-2064: any gtag() call that still reaches this stub while
  // window.OQ_INTERNAL is set (oqInternal() above, run unconditionally by
  // this file itself) gets traffic_type: 'internal' merged into its
  // params -- belt-and-suspenders for the case where this stub is somehow
  // reached without going through the early return below. The early return
  // itself is what actually stops the GA4 library and Clarity from ever
  // loading; this only marks a config/event call that has an object of its
  // own to carry the flag on.
  function gtag() {
    var args = arguments;
    if (window.OQ_INTERNAL) {
      if (args.length >= 3 && args[2] && typeof args[2] === 'object') {
        args[2].traffic_type = 'internal';
      } else if (args.length === 2 && (args[0] === 'config' || args[0] === 'event')) {
        args = [args[0], args[1], { traffic_type: 'internal' }];
      }
    }
    window.dataLayer.push(args);
  }
  window.gtag = gtag;
  gtag('js', new Date());

  // gh-2064 round 2: internal-traffic opt-out, checked via the self-contained
  // oqInternal() above -- not a dependency on js/internal-traffic.js being
  // present on this page. Placed after the dataLayer/gtag stub above so
  // every page's existing gtag(...) call sites keep working as harmless
  // queued-but-never-sent pushes (same reasoning as the
  // ALLOWED_HOSTS/CLARITY_ALLOWED_PATHS returns below) -- this just adds one
  // more reason the library and Clarity never actually load: the current
  // visit is our own walk/probe, not a visitor.
  if (OQ_INTERNAL_FLAG) {
    return;
  }

  if (ALLOWED_HOSTS.indexOf(window.location.hostname) === -1) {
    return; // not a recognised production host -- the GA4 library never loads
  }

  // gh-2063 fix round 2 (PR #2065 review, item 4): gtag.js's own parse+
  // execute cost (independently measured on this branch at ~384ms of main-
  // thread time) was still landing at DOMContentLoaded, so deferring the
  // *request* for this file did nothing for Total Blocking Time -- only
  // for when the fetch started. _oqLoadOnIdleOrInteraction (below) delays
  // creating this <script> tag itself until the browser is idle (or up to
  // 1500ms, whichever first) or the visitor's first interaction, whichever
  // happens first. Nothing else here changes: window.gtag/window.dataLayer
  // are still defined unconditionally above, so gtag('js', ...) and every
  // page's own gtag('config'/'event', ...) call keep queuing into
  // dataLayer exactly as before and are drained -- in order, including the
  // automatic page_view -- the moment gtag.js actually loads. A visit that
  // never goes idle and never interacts still gets gtag.js within 1500ms
  // via the requestIdleCallback timeout / setTimeout fallback, so page_view
  // still fires once for every visit that reaches that point, same as
  // before this change; only visitors who leave before ~1.5s (already
  // recorded as 0-click bounces before this fix) would not have generated
  // one previously fired at parse time either -- see the PR for the open
  // question this raises for Sloane/D-322 on attribution completeness.
  _oqLoadOnIdleOrInteraction(function () {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
    document.head.appendChild(s);
  });

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
  // behind the allowlist checks above and (gh-2063 fix round 2, item 4)
  // deferring only its own `<script src=clarity.ms/tag/...>` creation to
  // idle/interaction via _oqLoadOnIdleOrInteraction, same as the GA4 script
  // above. The queueing stub (`c[a] = c[a] || ...`) still runs synchronously,
  // right here, so `window.clarity` exists the instant this allowlist gate
  // is satisfied -- start.html's `clarity('set','variant',...)` call (moved
  // to a DOMContentLoaded listener in the same fix round, see that file's
  // own gh-2063 comment) depends on that. Any clarity(...) call made before
  // the real library loads keeps queuing into c[a].q exactly as the stub
  // always did, and is drained once it does. scripts/check-clarity-page-
  // gate.py's structural check anchors on this IIFE's exact 7-argument
  // signature (c, l, a, r, i, t, y) to confirm the allowlist gate above runs
  // before it -- that signature is unchanged; only its body's script-
  // insertion is now wrapped.
  (function (c, l, a, r, i, t, y) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
    _oqLoadOnIdleOrInteraction(function () {
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    });
  })(window, document, 'clarity', 'script', CLARITY_PROJECT_ID);
})();
