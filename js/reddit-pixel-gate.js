// gh-1926: Reddit Pixel host gate.
//
// Mirrors js/meta-pixel-gate.js (gh-1817) exactly, for the same reason
// that file mirrors js/ga-gate.js (gh-1619): the production GA4 tag used
// to load unconditionally on every host that served these pages --
// staging, branch-deploy previews, localhost -- alongside production
// (otterquote.com / app.otterquote.com), and a live read showed
// non-production hosts carrying the overwhelming majority of the
// property's volume. A fourth, independent tracking tag (Reddit Pixel)
// must not reintroduce that same failure. See gh-1619 for the full
// incident writeup; this file applies the identical fix to a fourth tag.
//
// This file is the single point where the Reddit Pixel library
// (redpixel.js) is allowed to load. It must be the ONLY place
// redpixel.js is requested -- do not add a second <script>/rdt(...)
// snippet anywhere; a per-file variant of this gate is how the gh-1619 bug
// recurs. Every page that fires rdt events includes this file first, then
// makes its own rdt('track', ...) calls.
//
// gh-1926: SHIPPED DARK. REDDIT_PIXEL_ID below is an empty-string
// placeholder -- no Reddit Ads account exists yet. This is a complete
// no-op on every host until a follow-up config drop lands the real ID
// (confirmed directly against Dustin's own screen, same verification
// standard as the Meta Pixel ID was), exactly like #1817 shipped Meta
// Pixel dark first. Do not invent a real ID here.
(function () {
  var ALLOWED_HOSTS = ['otterquote.com', 'www.otterquote.com', 'app.otterquote.com'];
  var REDDIT_PIXEL_ID = '';

  // Same self-contained opt-out as js/meta-pixel-gate.js's oqInternal()
  // (gh-2064 round 2) -- kept in sync with js/ga-gate.js,
  // js/meta-pixel-gate.js and js/internal-traffic.js (same cookie name,
  // Max-Age, Domain rule), wrapped in try/catch so it can never break tag
  // loading for a real visitor.
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

  // rdt is defined unconditionally, Reddit's own base-code shape, so
  // every page's existing rdt('track', ...) calls keep working (as
  // harmless queued-but-never-sent pushes) even when the pixel never
  // loads -- callers do not need to know whether the gate passed. Mirrors
  // js/meta-pixel-gate.js's fbq stub / gh-2000's callMethod-forwarding
  // fix: redpixel.js installs a `sendEvent` on this SAME rdt object once
  // it loads and drains whatever was queued at that point -- it does not
  // reassign window.rdt wholesale.
  if (!window.rdt) {
    var rdtStub = function () {
      rdtStub.sendEvent
        ? rdtStub.sendEvent.apply(rdtStub, arguments)
        : rdtStub.callQueue.push(arguments);
    };
    rdtStub.callQueue = [];
    window.rdt = rdtStub;
  }

  if (!REDDIT_PIXEL_ID) {
    return; // no real pixel ID configured yet -- complete no-op, dark merge
  }

  // gh-1925: the advertising-sharing opt-out (privacy.html Section 12). Same self-contained check as
  // js/meta-pixel-gate.js's oqAdOptOut() (gh-2107 / D-330, Ben's ruling on #2078, 5805593465, item a),
  // reading/writing the SAME oq_ad_optout cookie so an opt-out recorded by any gate on this device is
  // honoured by every other gate without asking again. Wrapped in try/catch so it can never break tag
  // loading for a real visitor.
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

  // gh-2064: internal-traffic opt-out, checked via the self-contained
  // oqInternal() above -- not a dependency on js/internal-traffic.js
  // being present on this page. Placed after the REDDIT_PIXEL_ID check
  // (same ordering as js/meta-pixel-gate.js) and the rdt stub so every
  // page's existing rdt('track', ...) call sites keep working as harmless
  // queued-but-never-sent pushes -- this just adds one more reason
  // redpixel.js never actually loads: the current visit is our own
  // walk/probe, not a visitor.
  if (oqInternal()) {
    return;
  }

  // gh-1925: an opted-out visitor (GPC, or the oq_ad_optout cookie GPC and js/meta-pixel-gate.js leave)
  // never loads redpixel.js.
  if (oqAdOptOut()) {
    return;
  }

  if (ALLOWED_HOSTS.indexOf(window.location.hostname) === -1) {
    return; // not a recognised production host -- redpixel.js never loads
  }

  // Same token-fragment guard as js/meta-pixel-gate.js (gh-1969) and
  // js/ga-gate.js (PR #1947 for Clarity): defense in depth against a live
  // Supabase access_token/refresh_token/provider_token pair ending up in
  // whatever URL-derived value a third-party tag library reports back to
  // its vendor.
  var hash = window.location.hash;
  var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
    hash.indexOf('refresh_token') !== -1 ||
    hash.indexOf('provider_token') !== -1;
  if (urlHasAuthToken) {
    return; // a live Supabase credential is in this URL; the pixel never loads.
  }

  // Own copy of js/meta-pixel-gate.js's _oqLoadOnIdleOrInteraction (that
  // file's comment on its copy explains why this is duplicated rather
  // than shared). Only the redpixel.js <script> insertion is delayed to
  // idle/interaction (capped at 1500ms) -- the rdt('init'...)/rdt('track',
  // 'PageVisit') calls right below stay exactly where they were,
  // synchronous, and keep queuing into rdtStub.callQueue exactly as
  // before.
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
    s.src = 'https://www.redditstatic.com/ads/redpixel.js';
    document.head.appendChild(s);
  });

  window.rdt('init', REDDIT_PIXEL_ID);
  window.rdt('track', 'PageVisit');
})();
