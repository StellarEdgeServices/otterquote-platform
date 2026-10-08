/* gh-2598 slice 1: motion, tabs, ZIP hand-off and GA4 events for the approved homepage reskin.
   Motion (design README): words 2-4 appear at 0.6 s, 1.7 s, 2.8 s; table rows take the active highlight in step; at 4.2 s all three settle. One pass, no loop.
   prefers-reduced-motion: render the finished state at once. Replay replays. Hidden words keep their layout space (opacity/transform only). */
(function () {
  'use strict';
  var d = document;
  var $ = function (s, r) { return (r || d).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || d).querySelectorAll(s)); };

  /* ---------- analytics: must never break the page ---------- */
  function track(name, params) { try { if (window.gtag) { window.gtag('event', name, params || {}); } } catch (e) {} }

  /* ---------- motion ---------- */
  var words = [$('#hr-w1'), $('#hr-w2'), $('#hr-w3')];
  var rows = { price: $('#hr-row-price'), materials: $('#hr-row-materials'), warranty: $('#hr-row-warranty') };
  var order = ['price', 'materials', 'warranty'];
  var tabs = $$('.hr-tab');
  var explain = $('#hr-explain');
  var IDLE = 'Sample layout. Your bids appear here, side by side.';
  var LINES = {
    price: 'Price: we submit one scope of work to multiple contractors.',
    materials: 'Materials: learn about the benefits of upgraded materials without being sold on them.',
    warranty: 'Warranty: we help you learn the difference between warranties so you can assess the real value of what contractors offer.'
  };
  var timers = [];
  function clear() { timers.forEach(clearTimeout); timers = []; }
  function render(step, focus) {
    words.forEach(function (w, i) { if (w) { w.classList.toggle('hr-on', step >= i + 1); } });
    order.forEach(function (name, i) {
      var hot = focus ? focus === name : step === i + 1;
      rows[name].classList.toggle('hr-hot', hot);
      rows[name].classList.toggle('hr-settled', !hot && step >= i + 1);
    });
    tabs.forEach(function (t) { t.setAttribute('aria-pressed', String(focus ? t.getAttribute('data-k') === focus : order[step - 1] === t.getAttribute('data-k'))); });
    explain.textContent = focus ? LINES[focus] : IDLE;
  }
  function calm() { try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function play() {
    clear();
    if (calm()) { render(4, ''); return; }
    render(0, '');
    [[1, 600], [2, 1700], [3, 2800], [4, 4200]].forEach(function (p) { timers.push(setTimeout(function () { render(p[0], ''); }, p[1])); });
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { clear(); render(4, t.getAttribute('data-k')); }); });
  var replay = $('#hr-replay');
  if (replay) { replay.addEventListener('click', play); }
  play();

  /* ---------- ZIP hand-off to /start (the role screen is skipped for this entry by slice 3) ---------- */
  var ATTR = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];
  function startUrl(zip) {
    var qs = [];
    try {
      var p = new URLSearchParams(window.location.search);
      ATTR.forEach(function (k) { var v = p.get(k); if (v) { qs.push(k + '=' + encodeURIComponent(v)); } });
    } catch (e) {}
    if (/^\d{5}$/.test(zip)) { qs.push('zip=' + zip); }
    qs.push('entry=home');
    return '/start.html?' + qs.join('&');
  }
  var zip = $('#hr-zip');
  var zipSent = false;
  function zipValue() { return zip ? zip.value.replace(/\D/g, '').slice(0, 5) : ''; }
  if (zip) {
    zip.addEventListener('input', function () {
      var v = zipValue();
      if (zip.value !== v) { zip.value = v; }
      if (v.length === 5 && !zipSent) { zipSent = true; track('zip_entered', { cta_location: 'hero' }); }
    });
    zip.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go('hero'); } });
  }
  function go(loc) {
    track('hero_cta_click', { cta_location: loc, zip_present: /^\d{5}$/.test(zipValue()) ? 'yes' : 'no' });
    window.location.href = startUrl(zipValue());
  }
  $$('[data-hr-go]').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); go(a.getAttribute('data-hr-go')); });
    a.setAttribute('href', startUrl(''));   /* no-JS / crawler fallback is the plain /start entry */
  });
  $$('a[data-hr-phone]').forEach(function (a) {
    a.addEventListener('click', function () { track('phone_click', { cta_location: a.getAttribute('data-hr-phone') }); });
  });

  /* ---------- phone sticky bar: shown once the hero button has scrolled out of view ---------- */
  var sticky = $('#hr-sticky'), heroBtn = $('#hr-hero-go');
  if (sticky && heroBtn && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (es) {
      var e = es[es.length - 1];
      var gone = !e.isIntersecting && e.boundingClientRect.top < 0;
      sticky.classList.toggle('hr-show', gone);
      sticky.setAttribute('aria-hidden', gone ? 'false' : 'true');
    }).observe(heroBtn);
  }
})();
