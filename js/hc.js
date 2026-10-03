// cro51 / #2121 HO-1 rebuild: behaviour shared by /hc and its four topic pages. Same pattern as the inline script in ho6.html.
//  - Every "get my bids" link goes to /ho6/start with utm_source=facebook, utm_medium=paid_social, utm_campaign=ho-1v2, utm_content=<page>.
//    An incoming utm_source / utm_medium / utm_term / fbclid / gclid replaces the default (or is carried), so paid-social attribution survives.
//    (/ho6/start itself forces leads.utm_campaign to 'ho-6' and leads.variant to 'ho6'; that page is unchanged. See the PR body.)
//  - Every link between hub and topic pages carries the visitor's incoming utm_* / fbclid / gclid unchanged.
//  - Events (router-style names, no PII, no lead id): router_step_view {variant:'hc', step, step_index, ua_context} once per page, and
//    router_choice_click {variant:'hc', step, choice, ua_context} on every choice / link click. GA4 loads only through js/ga-gate.js.
(function () {
  'use strict';
  var VARIANT = 'hc';
  var PAGE = document.body.getAttribute('data-hc-page') || 'hub';
  var STEP_INDEX = { hub: 0, 'save-money': 1, materials: 1, warranties: 1, decisions: 1 };
  var PASS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];
  function clean(v) { return typeof v === 'string' ? v.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 1000) : ''; }
  var incoming = {};
  try {
    var sp = new URLSearchParams(window.location.search);
    PASS.forEach(function (k) { var v = clean(sp.get(k)); if (v) { incoming[k] = v; } });
  } catch (e) { incoming = {}; }
  function qs(pairs) { return pairs.map(function (p) { return p[0] + '=' + encodeURIComponent(p[1]); }).join('&'); }
  // /ho6/start link: fixed campaign and content, incoming source / medium / term / click ids win over the defaults.
  function bidsHref() {
    var pairs = [
      ['utm_source', incoming.utm_source || 'facebook'],
      ['utm_medium', incoming.utm_medium || 'paid_social'],
      ['utm_campaign', 'ho-1v2'],
      ['utm_content', PAGE]
    ];
    ['utm_term', 'fbclid', 'gclid'].forEach(function (k) { if (incoming[k]) { pairs.push([k, incoming[k]]); } });
    return '/ho6/start?' + qs(pairs);
  }
  // hub <-> topic links: everything the visitor arrived with, unchanged.
  function passHref(href) {
    var pairs = PASS.filter(function (k) { return incoming[k]; }).map(function (k) { return [k, incoming[k]]; });
    return pairs.length ? href + '?' + qs(pairs) : href;
  }
  var uaContext = 'other';
  try {
    var ua = navigator.userAgent || '';
    if (/FBAN|FBAV|FB_IAB/.test(ua)) { uaContext = 'fb_iab'; } else if (/Instagram/.test(ua)) { uaContext = 'ig_iab'; }
  } catch (e) { /* other */ }
  function track(name, extra) {
    try {
      var p = extra || {};
      p.variant = VARIANT;   // no PII, no lead id: nothing on these pages knows who the visitor is
      p.ua_context = uaContext;
      gtag('event', name, p);
    } catch (e) { /* analytics must never break the page */ }
  }
  var links = document.querySelectorAll('a[data-hc-choice]');
  for (var i = 0; i < links.length; i++) {
    (function (a) {
      var choice = a.getAttribute('data-hc-choice');
      if (a.getAttribute('data-hc-dest') === 'bids') { a.setAttribute('href', bidsHref()); }
      else { a.setAttribute('href', passHref(a.getAttribute('href'))); }
      a.addEventListener('click', function () { track('router_choice_click', { step: PAGE, choice: choice }); });
    })(links[i]);
  }
  track('router_step_view', { step: PAGE, step_index: STEP_INDEX[PAGE] });
  // Clarity tag, once js/ga-gate.js has run (it creates window.clarity, and only when the host/path gates allow).
  function tagClarity() { try { if (window.clarity) { clarity('set', 'variant', VARIANT); clarity('set', 'step', PAGE); } } catch (e) {} }
  if (window.__oqGateReady) { tagClarity(); } else { (window.__oqOnGateReady = window.__oqOnGateReady || []).push(tagClarity); }
  // Gates load on idle or first interaction (same pattern as ho6.html / start.html), so they never sit ahead of the first paint.
  var EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'], fired = false;
  function run() {
    if (fired) return; fired = true;
    for (var j = 0; j < EVENTS.length; j++) { window.removeEventListener(EVENTS[j], run); }
    var g = document.createElement('script'); g.src = '/js/ga-gate.js';
    g.onload = function () {
      window.__oqGateReady = true;
      var cbs = window.__oqOnGateReady || []; window.__oqOnGateReady = [];
      for (var k = 0; k < cbs.length; k++) { try { cbs[k](); } catch (e) {} }
    };
    document.head.appendChild(g);
    var m = document.createElement('script'); m.src = '/js/meta-pixel-gate.js'; document.head.appendChild(m);
  }
  for (var j = 0; j < EVENTS.length; j++) { window.addEventListener(EVENTS[j], run, { passive: true, once: true }); }
  if (window.requestIdleCallback) { window.requestIdleCallback(run, { timeout: 300 }); } else { setTimeout(run, 300); }
})();
