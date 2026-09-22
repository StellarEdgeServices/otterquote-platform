// gh-1926: LinkedIn Insight Tag host gate.
//
// Mirrors js/meta-pixel-gate.js (gh-1817) exactly, for the same reason
// that file mirrors js/ga-gate.js (gh-1619): the production GA4 tag used
// to load unconditionally on every host that served these pages --
// staging, branch-deploy previews, localhost -- alongside production
// (otterquote.com / app.otterquote.com), and a live read showed
// non-production hosts carrying the overwhelming majority of the
// property's volume. A third, independent tracking tag (LinkedIn Insight
// Tag) must not reintroduce that same failure. See gh-1619 for the full
// incident writeup; this file applies the identical fix to a third tag.
//
// This file is the single point where the LinkedIn Insight Tag library
// (insight.min.js) is allowed to load. It must be the ONLY place
// insight.min.js is requested -- do not add a second <script>/lintrk(...)
// snippet anywhere; a per-file variant of this gate is how the gh-1619 bug
// recurs. Every page that fires lintrk conversion events includes this
// file first, then makes its own lintrk('track', ...) calls.
//
// gh-1926: SHIPPED DARK. LINKEDIN_PARTNER_ID and LINKEDIN_CONVERSION_ID
// below are empty-string placeholders -- no LinkedIn Campaign Manager
// account/ad account exists yet. This is a complete no-op on every host
// until a follow-up config drop lands both real IDs (confirmed directly
// against Dustin's own screen, same verification standard as the Meta
// Pixel ID was), exactly like #1817 shipped Meta Pixel dark first. Do not
// invent a real ID here.
(function () {
  var ALLOWED_HOSTS = ['otterquote.com', 'www.otterquote.com', 'app.otterquote.com'];
  var LINKEDIN_PARTNER_ID = '';
  // LinkedIn's conversion tracking API requires a Conversion ID that is
  // distinct from the Partner ID (unlike Meta, which reuses one PIXEL_ID
  // for both PageView and Lead). Left as its own empty placeholder so the
  // follow-up config drop can set it once a real LinkedIn Conversion
  // action exists -- do not reuse LINKEDIN_PARTNER_ID's value here.
  var LINKEDIN_CONVERSION_ID = '';

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

  // lintrk is defined unconditionally, LinkedIn's own base-code shape, so
  // every page's existing lintrk('track', ...) calls keep working (as
  // harmless queued-but-never-sent pushes) even when the tag never loads
  // -- callers do not need to know whether the gate passed. Mirrors
  // js/meta-pixel-gate.js's fbq stub / gh-2000's callMethod-forwarding
  // fix: insight.min.js installs a `callMethod` on this SAME lintrk
  // object once it loads and drains whatever was queued at that point --
  // it does not reassign window.lintrk wholesale.
  if (!window.lintrk) {
    var lintrkStub = function () {
      lintrkStub.callMethod
        ? lintrkStub.callMethod.apply(lintrkStub, arguments)
        : lintrkStub.queue.push(arguments);
    };
    lintrkStub.queue = [];
    window.lintrk = lintrkStub;
  }
  window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];

  // Conversion (Lead) helper -- callers use this instead of a raw
  // lintrk('track', ...) call so the LINKEDIN_CONVERSION_ID placeholder
  // stays in exactly one place. Defined unconditionally, before any of
  // the gate checks below, same reasoning as the lintrk stub above: safe
  // to call from every page regardless of whether the gate ever passes --
  // it is a no-op while LINKEDIN_CONVERSION_ID is empty, and even once a
  // real ID lands, lintrk itself stays a harmless queue until
  // insight.min.js actually loads (which the checks below still gate).
  window.oqLinkedInTrackLead = function () {
    if (!LINKEDIN_CONVERSION_ID) {
      return; // no real conversion ID configured yet -- dark merge
    }
    window.lintrk('track', { conversion_id: LINKEDIN_CONVERSION_ID });
  };

  if (!LINKEDIN_PARTNER_ID) {
    return; // no real partner ID configured yet -- complete no-op, dark merge
  }

  // gh-2064: internal-traffic opt-out, checked via the self-contained
  // oqInternal() above -- not a dependency on js/internal-traffic.js
  // being present on this page. Placed after the LINKEDIN_PARTNER_ID
  // check (same ordering as js/meta-pixel-gate.js) and the lintrk stub so
  // every page's existing lintrk('track', ...) call sites keep working as
  // harmless queued-but-never-sent pushes -- this just adds one more
  // reason insight.min.js never actually loads: the current visit is our
  // own walk/probe, not a visitor.
  if (oqInternal()) {
    return;
  }

  if (ALLOWED_HOSTS.indexOf(window.location.hostname) === -1) {
    return; // not a recognised production host -- insight.min.js never loads
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
    return; // a live Supabase credential is in this URL; the tag never loads.
  }

  // Own copy of js/meta-pixel-gate.js's _oqLoadOnIdleOrInteraction (that
  // file's comment on its copy explains why this is duplicated rather
  // than shared). Only the insight.min.js <script> insertion is delayed
  // to idle/interaction (capped at 1500ms) -- the lintrk push queue above
  // stays exactly where it is, synchronous.
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

  window._linkedin_data_partner_ids.push(LINKEDIN_PARTNER_ID);

  _oqLoadOnIdleOrInteraction(function () {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://snap.licdn.com/li.lms-analytics/insight.min.js';
    document.head.appendChild(s);
  });
})();
