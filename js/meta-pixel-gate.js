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

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://connect.facebook.net/en_US/fbevents.js';
  document.head.appendChild(s);

  window.fbq('init', PIXEL_ID);
  window.fbq('track', 'PageView');
})();
