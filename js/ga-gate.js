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
// Fail-closed by design: an unrecognised hostname is far more likely to be
// a new preview/staging surface than a new production domain, so it never
// loads the library. Extending the allowlist is a deliberate, reviewed
// decision, not a default.
(function () {
  var ALLOWED_HOSTS = ['otterquote.com', 'www.otterquote.com', 'app.otterquote.com'];
  var MEASUREMENT_ID = 'G-D1Y1TLGEFY';

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
})();
