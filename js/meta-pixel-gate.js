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

  // gh-2107 / D-330 (Ben's ruling on #2078, 5805593465, item a; privacy policy Section 12 promises an opt-out of SHARING, not
  // of one channel): a visitor who has opted out of advertising sharing never loads the Meta Pixel. Two signals, kept in
  // sync with react-app/app/lib/ad-optout.ts: the browser's Global Privacy Control (navigator.globalPrivacyControl === true),
  // and the `oq_ad_optout=1` cookie that GPC, the React app's read of profiles.ad_sharing_opt_out, and this function leave
  // behind (1 year, Domain=.otterquote.com, same shape as oq_internal). Synchronous, wrapped so it can never break a page.
  function oqWriteAdOptOutCookie() {
    try {
      var domainAttr = '';
      if (/(^|\.)otterquote\.com$/.test(window.location.hostname)) {
        domainAttr = '; Domain=.otterquote.com';
      }
      document.cookie = 'oq_ad_optout=1; Max-Age=' + (60 * 60 * 24 * 365) + '; Path=/' + domainAttr + '; SameSite=Lax';
    } catch (e) { /* never break a page over a cookie */ }
  }

  function oqAdOptOut() {
    try {
      var cookieMatch = document.cookie.match(/(?:^|; )oq_ad_optout=([^;]*)/);
      var cookieFlag = !!(cookieMatch && decodeURIComponent(cookieMatch[1]) === '1');
      var gpc = (typeof navigator !== 'undefined') && navigator.globalPrivacyControl === true;
      if (gpc && !cookieFlag) {
        oqWriteAdOptOutCookie();
      }
      return gpc || cookieFlag;
    } catch (e) {
      return false;
    }
  }

  // gh-2107 (REVIEW: FAIL 5806828503 F1 on #2134): the STORED opt-out (profiles.ad_sharing_opt_out = true) must follow the known person
  // to every page, not only to /help-measurements: an opt-out recorded by GPC in another browser, or by an admin from a support email
  // (privacy policy Section 12), never sets the cookie on this device. So whenever the SSO session cookie is present (the access token
  // js/cookie-storage.js writes at Domain=.otterquote.com), the signed-in user's own profile flag is read BEFORE fbevents.js loads, and
  // the pixel loads only on a definite `false`. With no session cookie nothing is knowable and the pixel loads as before. A session
  // whose flag cannot be read (an expired token, an error, no config, an unreadable token) never loads the pixel: an unknown opt-out
  // is not shared. The read is a plain REST GET with the user's own token, so row-level security limits it to their own row and it
  // does not depend on supabase-js having loaded yet. Synchronous GPC / cookie checks above still win and make no read.
  function oqSessionToken() {
    try {
      var m = document.cookie.match(/(?:^|; )sb-otterquote-at=([^;]*)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) {
      return null;
    }
  }

  function oqTokenUserId(token) {
    try {
      var parts = String(token).split('.');
      if (parts.length !== 3) return null;
      var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      // A plain UUID only: the id goes into a URL, so anything else is refused rather than interpolated.
      return (payload && typeof payload.sub === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sub)) ? payload.sub : null;
    } catch (e) {
      return null;
    }
  }

  // Resolves true (opted out), false (definitely not), or 'unknown'. Waits up to 5 s for js/config.js (loaded later on the page).
  function oqReadStoredOptOut(token) {
    return new Promise(function (resolve) {
      var uid = oqTokenUserId(token);
      if (!uid || typeof fetch !== 'function') { resolve('unknown'); return; }
      var waited = 0;
      (function attempt() {
        var cfg = null;
        try { cfg = (typeof CONFIG !== 'undefined') ? CONFIG : null; } catch (e) { cfg = null; }
        if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON) {
          if (waited >= 5000) { resolve('unknown'); return; }
          waited += 100;
          setTimeout(attempt, 100);
          return;
        }
        try {
          fetch(String(cfg.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/profiles?select=ad_sharing_opt_out&id=eq.' + encodeURIComponent(uid), {
            method: 'GET',
            headers: { apikey: cfg.SUPABASE_ANON, Authorization: 'Bearer ' + token, Accept: 'application/json' }
          }).then(function (r) {
            return r && r.ok ? r.json() : null;
          }).then(function (rows) {
            if (!Array.isArray(rows)) { resolve('unknown'); return; }
            resolve(rows.length > 0 && rows[0] && rows[0].ad_sharing_opt_out === true);
          }).catch(function () { resolve('unknown'); });
        } catch (e) {
          resolve('unknown');
        }
      })();
    });
  }

  // Runs `insert` (the fbevents.js <script> insertion) only if it is allowed: no session cookie -> yes (as before); a session -> only
  // when the stored flag reads as a definite `false`. A `true` also leaves the cookie for every later page.
  function oqInsertUnlessStoredOptOut(insert) {
    var token = oqSessionToken();
    if (!token) { insert(); return; }
    if (typeof Promise === 'undefined') { return; } // cannot read the flag: unknown is not shared
    oqReadStoredOptOut(token).then(function (v) {
      if (v === false) { insert(); }
      else if (v === true) { oqWriteAdOptOutCookie(); }
    });
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

  // gh-2107: an opted-out visitor never loads fbevents.js (see oqAdOptOut above). Checked after the fbq stub so every page's
  // existing fbq(...) call sites stay harmless queued-but-never-sent pushes, exactly as for the other reasons not to load.
  if (oqAdOptOut()) {
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

  // gh-2107 / #2106 gaps (REVIEW B1 on #2139): a credential in the QUERY STRING reaches Meta the same way (fbevents.js reads
  // location.href for `dl`; the pixel's server config strips no keys), so the query is guarded too -- by EXACT parameter name, not
  // by substring, and NOT `code`: `code` is this site's own referral parameter (`?code=`, js/ga-gate.js gh-1931) and promocode /
  // zipcode / mytoken must keep loading. Kept in sync with react-app/app/components/MetaPixelGate.tsx (queryHasAuthToken).
  var authQueryKeys = ['access_token', 'refresh_token', 'provider_token', 'token_hash', 'token'];
  var queryHasAuthToken = false;
  try {
    var queryParams = new URLSearchParams(window.location.search);
    for (var qk = 0; qk < authQueryKeys.length; qk++) {
      if (queryParams.has(authQueryKeys[qk])) { queryHasAuthToken = true; }
    }
  } catch (e) {
    queryHasAuthToken = true; // an unparseable query string: fail closed
  }
  if (queryHasAuthToken) {
    return; // a live credential is in the query string; the pixel never loads.
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
    oqInsertUnlessStoredOptOut(function () {
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://connect.facebook.net/en_US/fbevents.js';
      document.head.appendChild(s);
    });
  });

  // gh-2107 / #2106 gaps (REVIEW B2 on #2139): fbevents.js wraps pushState / replaceState / popstate and sends its OWN PageView on a
  // client-side URL change once any event has fired. `disablePushState` stops that; it must be set before `init`.
  window.fbq.disablePushState = true;
  window.fbq('init', PIXEL_ID);
  window.fbq('track', 'PageView');
})();
