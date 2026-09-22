// gh-1817: Meta Pixel host gate.
//
// Mirrors js/ga-gate.js (gh-1619) exactly, for the exact reason that fix
// exists: the production GA4 tag used to load unconditionally on every host
// that served these pages -- staging, branch-deploy previews, localhost --
// alongside production (otterquote.com / app.otterquote.com), and a live
// read showed non-production hosts carrying the overwhelming majority of
// the property's volume. A second, independent tracking tag (Meta Pixel)
// must not reintroduce that same failure. See gh-1619 for the full incident
// writeup; this file applies the identical fix to a second tag.
//
// This file is the single point where the Meta Pixel library (fbevents.js)
// is allowed to load. It must be the ONLY place fbevents.js is requested --
// do not add a second <script>/fbq('init', ...) snippet anywhere; a
// per-file variant of this gate is how the gh-1619 bug recurs. Every page
// that fires fbq events includes this file first, then makes its own
// fbq('track', ...) calls.
//
// gh-1817 item 4 -- LIVE (ceo42/gh1817-meta-pixel-live, supersedes #1839,
// D-322/D-323): the placeholder empty-string PIXEL_ID below has been
// replaced with the real Meta Pixel ID now that Dustin has a Business
// Manager + ad account. The host allowlist below is what actually gates
// firing on production vs. staging/preview/localhost -- see the check
// immediately below the ID.
//
// gh-1969: fbevents.js derives its `dl` (document link) parameter from
// window.location.href / a ComparedURL helper (confirmed by fetching the
// served connect.facebook.net/en_US/fbevents.js and reading it directly --
// it reads location internally; there is no fbq('set', ...) or fbq('init',
// ..., {...}) option that overrides dl to a fragment-stripped value, and
// the "unwanteddata" plugin only strips server-configured query keys, never
// the fragment). So unlike a param we could scrub before firing, the only
// way to keep a live Supabase access_token/refresh_token/provider_token
// pair (implicit-flow OAuth, js/auth.js) out of the facebook.com/tr `dl`
// value is to never load fbevents.js at all while the fragment carries one.
// This is the exact predicate PR #1947 added to js/ga-gate.js for Clarity
// -- see that file's gh-1931 (round 2) comment for why it is a fragment
// substring check and not a page-path allowlist: "a path list can never be
// complete." Residual risk this does not close: a future token shape that
// does not use these three fragment key names would not match this
// predicate; if Supabase or a future auth provider ever adds a differently
// named implicit-flow fragment parameter, this gate (and ga-gate.js) both
// need updating together.
(function () {
  var ALLOWED_HOSTS = ['otterquote.com', 'www.otterquote.com', 'app.otterquote.com'];
  var PIXEL_ID = '800470107451795';

  // gh-2064 round 2: same fix and same rationale as js/ga-gate.js's
  // oqInternal() -- the opt-out used to live only in js/internal-traffic.js,
  // included on 10 of the 62 pages that load this gate, so on the other 52
  // `if (window.OQ_INTERNAL) return;` below never had anything to read.
  // This gate now reads and writes the signal itself, kept in sync with
  // js/ga-gate.js and js/internal-traffic.js (same cookie name, Max-Age,
  // Domain rule), wrapped in try/catch so it can never break pixel loading
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
      return !!window.OQ_INTERNAL;
    }
  }

  // fbq is defined unconditionally so every page's existing
  // fbq('track', ...) / fbq('trackCustom', ...) calls keep working (as
  // harmless queued-but-never-sent pushes) even when the pixel never loads
  // -- callers do not need to know whether the gate passed.
  //
  // gh-2000: this must be Meta's standard base-code stub, not just a queue
  // push. fbevents.js does not reassign window.fbq wholesale -- it installs
  // a `callMethod` property on the SAME fbq object and drains whatever was
  // queued at load time exactly once. A stub that only ever pushes to the
  // queue keeps "working" for init/PageView (queued before fbevents.js
  // loads, drained on load) while silently black-holing every event fired
  // afterward (Lead on submit, any trackCustom, etc.), because nothing
  // reads the queue again once fbevents.js has taken over via callMethod.
  // See #2000 for the live proof (fbq.callMethod.apply(...) reaches Meta,
  // the plain stub call does not).
  if (!window.fbq) {
    var fbqStub = function () {
      fbqStub.callMethod
        ? fbqStub.callMethod.apply(fbqStub, arguments)
        : fbqStub.queue.push(arguments);
    };
    window.fbq = fbqStub;
    if (!window._fbq) { window._fbq = fbqStub; }
    fbqStub.push = fbqStub;
    fbqStub.loaded = true;
    fbqStub.version = '2.0';
    fbqStub.queue = [];
  }

  if (!PIXEL_ID) {
    return; // no real pixel ID configured yet -- complete no-op, dark merge
  }

  // gh-2064 round 2: internal-traffic opt-out, checked via the
  // self-contained oqInternal() above -- not a dependency on
  // js/internal-traffic.js being present on this page. Placed after the PIXEL_ID check (the react-app stub test slices the
  // source up to that check, gh-2000) and the fbq stub so every page's existing fbq('track', ...) call sites keep
  // working as harmless queued-but-never-sent pushes -- this just adds one
  // more reason fbevents.js never actually loads: the current visit is our
  // own walk/probe, not a visitor.
  if (oqInternal()) {
    return;
  }


  if (ALLOWED_HOSTS.indexOf(window.location.hostname) === -1) {
    return; // not a recognised production host -- fbevents.js never loads
  }

  var hash = window.location.hash;
  var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
    hash.indexOf('refresh_token') !== -1 ||
    hash.indexOf('provider_token') !== -1;
  if (urlHasAuthToken) {
    return; // a live Supabase credential is in this URL; the pixel never loads.
  }

  // gh-2063 fix round 2 (PR #2065 review, item 4): own copy of
  // js/ga-gate.js's _oqLoadOnIdleOrInteraction (that file's comment on its
  // copy explains why this is duplicated rather than shared). Only the
  // fbevents.js <script> insertion is delayed to idle/interaction (capped
  // at 1500ms) -- the fbq('init'...)/fbq('track','PageView') calls right
  // below stay exactly where they were, synchronous, and keep queuing into
  // fbqStub.queue exactly as before. gh-2000's callMethod drain fires that
  // queued init+PageView the moment fbevents.js actually loads, so PageView
  // still fires once per visit, just later.
  //
  // gh-2063 fix round 4 -- TRIED AND REVERTED (Marty/CTO ruling, comment
  // 5780493814, tried raising this ceiling to 3000ms; reverted on PR
  // #2111 review, comment 5781473696): measured no benefit (same-harness
  // A/B, devtools throttling, 3-run medians -- TBT 1017ms vs 1004ms,
  // inside noise; LCP slightly worse) while doubling the no-tag-fired
  // window for a visitor who bounces before interacting or before genuine
  // idle -- exactly the fast-bouncing FB in-app population this issue
  // targets. Reverted to 1500ms pending Marty/Ben re-deciding with these
  // numbers in front of them (Q posted on #2063). See PR #2111.
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
    if (window.requestIdleCallback) {
      idleHandle = window.requestIdleCallback(run, { timeout: 1500 });
    } else {
      timeoutHandle = setTimeout(run, 1500);
    }
  }

  _oqLoadOnIdleOrInteraction(function () {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(s);
  });

  window.fbq('init', PIXEL_ID);
  window.fbq('track', 'PageView');
})();
