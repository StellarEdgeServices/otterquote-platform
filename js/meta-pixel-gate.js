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
(function () {
  var ALLOWED_HOSTS = ['otterquote.com', 'www.otterquote.com', 'app.otterquote.com'];
  var PIXEL_ID = '800470107451795';

  // fbq is defined unconditionally so every page's existing
  // fbq('track', ...) / fbq('trackCustom', ...) calls keep working (as
  // harmless queued-but-never-sent pushes) even when the pixel never loads
  // -- callers do not need to know whether the gate passed.
  window.fbq = window.fbq || function () {
    (window.fbq.queue = window.fbq.queue || []).push(arguments);
  };

  if (!PIXEL_ID) {
    return; // no real pixel ID configured yet -- complete no-op, dark merge
  }

  if (ALLOWED_HOSTS.indexOf(window.location.hostname) === -1) {
    return; // not a recognised production host -- fbevents.js never loads
  }

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://connect.facebook.net/en_US/fbevents.js';
  document.head.appendChild(s);

  window.fbq('init', PIXEL_ID);
  window.fbq('track', 'PageView');
})();
