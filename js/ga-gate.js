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

  // Microsoft Clarity -- the vendor snippet, verbatim apart from living
  // behind the allowlist check above. Reached only on a production host.
  (function (c, l, a, r, i, t, y) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
    t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
    y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
  })(window, document, 'clarity', 'script', CLARITY_PROJECT_ID);
})();
