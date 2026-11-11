// HeyCatch analytics, marketing site. Loaded ONLY by js/ga-gate.js, which has
// already applied the production-host, internal-traffic, opt-out, auth-token
// and public-page gates. Do not add a <script> tag for this file to a page.
//
// Deviations from https://heycatch.ai/agents.md, each deliberate:
//  - Same-origin copy of @heycatch/sdk 0.8.3 (npm dist/index.js), not esm.sh:
//    no extra third-party CDN gets to run code on our pages.
//  - Loaded through the gate, not unconditionally in <head>: an unconditional
//    init would run on staging and on signed-in pages.
//  - UTM restore below: 0.8.3 strips utm_source/utm_medium/utm_campaign from
//    the URL one second after init on ANY link with utm_campaign, not only its
//    own short links, which would hide ad attribution from anything reading
//    the URL later.
//  - gh-3352: the SDK is imported DYNAMICALLY, after js/heycatch-privacy.js has
//    removed the toolbar triggers. A static import would evaluate the SDK first,
//    and the SDK reads location.hash when its module is evaluated, so a
//    /faq#__posthog=... link would load in.heycatch.ai/static/toolbar.js before
//    any code here could stop it. beforeSend strips query strings and fragments
//    from every URL-bearing property (see the header of js/heycatch-privacy.js).
import { makeBeforeSend, hideToolbarTrigger, makeEventTracker } from '/js/heycatch-privacy.js';

var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'];
var kept = {};
try {
  var start = new URLSearchParams(window.location.search);
  if (start.get('utm_campaign') !== null && start.get('utm_source') !== 'heycatch') {
    UTM_KEYS.forEach(function (k) {
      if (start.get(k) !== null) kept[k] = start.get(k);
    });
  }
} catch (e) { /* no UTMs to keep */ }

var guard = hideToolbarTrigger();
if (guard) {
  import('/js/vendor/heycatch-sdk-0.8.3.js').then(function (sdk) {
    sdk.analytics.init({
      projectKey: 'hck_pk_EDCHqNmpbCRmDWZD6PCDsAEczZa0eWr6',
      site: 'landing',
      requestBatching: false,
      install: { framework: 'web', agent: 'claude-code' },
      beforeSend: makeBeforeSend()
    });
    guard.restore();
    // gh-3389 (D-409): the one named goal event, no properties, no identity. Pages call window.__oqHcTrack('lead_saved')
    // after the leads row is saved; if this file never loaded (blocked, opted out, page not on the gate) the hook does not
    // exist and the call is skipped. See makeEventTracker in js/heycatch-privacy.js.
    window.__oqHcTrack = makeEventTracker(function (n) { sdk.analytics.trackEvent(n); });
    if (Object.keys(kept).length) {
      setTimeout(function () {
        var now = new URLSearchParams(window.location.search);
        var changed = false;
        Object.keys(kept).forEach(function (k) {
          if (now.get(k) === null) { now.set(k, kept[k]); changed = true; }
        });
        if (changed) {
          window.history.replaceState(window.history.state, '', window.location.pathname + '?' + now.toString() + window.location.hash);
        }
      }, 1100);
    }
  }).catch(function (e) {
    guard.restore();
    try { console.error('[HeyCatch] not loaded', e && e.message); } catch (e2) { /* no console */ }
  });
}
