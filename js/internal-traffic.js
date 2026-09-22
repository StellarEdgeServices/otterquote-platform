// gh-2064: internal-traffic opt-out.
//
// Our own automated walks/probes (pre-flight-walk, forge, auth-doctor,
// perf-doctor, Playwright E2E, CI smoke tests) hit these pages the same way
// a real visitor would, and were being counted as sessions in GA4, Clarity
// and Meta -- polluting every conversion rate and funnel denominator those
// tools feed, the same class of problem gh-1619 fixed for staging/preview
// hosts. This file is the single opt-out every tag loader on this site
// checks before it loads anything.
//
// Contract: visiting ANY page with ?oq_internal=1 (or &oq_internal=1) sets
// window.OQ_INTERNAL = true for the rest of this page load, AND writes a
// `oq_internal=1` cookie (1 year, domain=.otterquote.com, path=/) so every
// later navigation on this device -- including ones that do not carry the
// query param, e.g. a walk clicking an in-page link -- is still recognised
// as internal without every single driver having to append the param to
// every navigation. Once the cookie is set, window.OQ_INTERNAL is also true
// on any page that carries it, param or not.
//
// This file must load, and run, before js/ga-gate.js and
// js/meta-pixel-gate.js on every page (see the <script> ordering those two
// files' own docstrings require) -- it does not load or gate anything
// itself, it only sets the flag those loaders check.
(function () {
  function readCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function writeCookie(name, value) {
    var oneYear = 60 * 60 * 24 * 365;
    var domainAttr = '';
    // gh-2064: scope to .otterquote.com per the issue so the flag is shared
    // across otterquote.com / www.otterquote.com / app.otterquote.com. On
    // any other host (localhost, a Netlify preview, a Playwright fixture
    // server) a `.otterquote.com` cookie domain would be rejected by the
    // browser outright and silently fail to set, so it is only applied on
    // an actual otterquote.com host.
    if (/(^|\.)otterquote\.com$/.test(window.location.hostname)) {
      domainAttr = '; domain=.otterquote.com';
    }
    document.cookie = name + '=' + encodeURIComponent(value) +
      '; max-age=' + oneYear +
      '; path=/' +
      domainAttr +
      '; SameSite=Lax';
  }

  var params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (e) {
    params = null;
  }

  var queryFlag = !!(params && params.get('oq_internal') === '1');
  var cookieFlag = readCookie('oq_internal') === '1';

  if (queryFlag && !cookieFlag) {
    writeCookie('oq_internal', '1');
  }

  window.OQ_INTERNAL = queryFlag || cookieFlag;
})();
