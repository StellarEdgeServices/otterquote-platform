/*
 * guarantee-gate.js (gh-3635, P23 part 2) -- the ONE switch for the 100-hour guarantee wording.
 *
 * Every guarantee block on the site carries class="oq-guarantee" and the HTML `hidden` attribute, so it renders
 * nothing by default. This file un-hides them only when GUARANTEE_LIVE is true.
 *
 * GUARANTEE_LIVE ships FALSE. Per gh-3635 / gh-3471: no page may show the guarantee until #3471's covered mark
 * works end to end on the page side (the write side, hover_orders.guarantee_covered, is on main; no page reads it yet).
 * Turning this on is a separate, reviewed one-line change made at that time (R-177).
 *
 * The purchase-step block also carries data-guarantee-needs-covered: even with GUARANTEE_LIVE true it stays hidden
 * until the page sets window.OQ_GUARANTEE_COVERED = true for THIS home (covered state, from #3471's mark, before the
 * homeowner pays). Nothing sets that variable yet, so that block cannot appear by accident.
 */
(function () {
  var GUARANTEE_LIVE = false;
  if (!GUARANTEE_LIVE) return;

  function reveal() {
    var els = document.querySelectorAll('.oq-guarantee');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.hasAttribute('data-guarantee-needs-covered') && window.OQ_GUARANTEE_COVERED !== true) continue;
      el.hidden = false;
    }
    if (location.hash === '#guarantee-terms') {
      var t = document.getElementById('guarantee-terms');
      if (t && !t.hidden && t.scrollIntoView) t.scrollIntoView();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reveal);
  else reveal();
})();
