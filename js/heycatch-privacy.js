// HeyCatch privacy helpers, marketing site. Pure functions, no side effects at
// import, no SDK import: js/heycatch-boot.js imports this BEFORE it imports the
// SDK, because the SDK reads location.hash the moment it is evaluated.
//
// react-app/app/lib/heycatch-privacy.ts is the typed mirror for the app.
// tests/gh3352-heycatch-privacy.mjs runs both against the same cases, so a
// change to one that is not made to the other fails CI.
//
// gh-3352 item 1: what HeyCatch is allowed to receive in a URL-bearing property.
//   Current-page URLs ($current_url, $initial_current_url, $session_entry_url):
//     origin + path + ONLY these query keys, and only when the value is short and
//     has no "@" at any level of percent-decoding (so "x%2540y.com" is out):
//     utm_source, utm_medium, utm_campaign, utm_content, utm_term. The SDK's
//     standalone campaign properties (utm_term, $initial_utm_term,
//     $session_entry_utm_term, also in $set_once) follow the same value rule, and
//     the campaign keys the URL rule drops (mc_cid, gad_source, gclid, fbclid ...)
//     and ph_keyword are dropped there too.
//     They are what attribution-core.ts and get-started read, and what the
//     boot's UTM restore puts back. Everything else is dropped: claim_id, email,
//     code, token, gclid and fbclid (the SDK already masks those two), job_type,
//     v and anything unknown. The fragment is always dropped.
//   Referrers (any key ending in "referrer": $referrer, $initial_referrer,
//     $session_entry_referrer): ORIGIN ONLY, no path, query or fragment ("$direct"
//     is kept; a value that is not an http(s) URL is dropped). The legal read of
//     #3360 found that a referrer path names signed-in pages and can carry a claim id.
//   $external_click_url and link targets in autocapture ($elements attr__href,
//     href, $elements_chain): origin + path, no query, no fragment.
//     mailto:, tel:, sms:, javascript: and data: values are cut to the scheme.
//   Left alone: $pathname, $host, $referring_domain, $session_entry_pathname and
//     the other path or host-only properties. They carry no query.
//   gh-3357: a path property can still NAME a page HeyCatch must not see. The SDK
//     records every page the visitor moves to inside one document (history_change)
//     even when beforeSend drops that page's events, and the next allowed pageview
//     carries it as $prev_pageview_pathname ("/contractor/bid/<claimId>" in the app).
//     makeBeforeSend(gate, pathAllowed): with pathAllowed, every property whose name
//     ends in "pathname", and every current-page URL property ($session_entry_url and
//     the rest of CURRENT_URL_KEYS) whose path is not allowed, is dropped unless
//     pathAllowed(path) is true (the app passes its route allowlist). Without it
//     (the marketing site, where every page is a full load and the SDK only starts
//     on an allowlisted page), $prev_pageview_pathname is kept only when it is the
//     event's own $pathname.
//   Any other string property whose name ends in url, href, action or src is
//     scrubbed like a link target, and one ending in referrer like a referrer, so a
//     property the SDK adds later fails closed.

var KEEP_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
var MAX_KEPT_VALUE = 100;
var CURRENT_URL_KEYS = ['$current_url', '$initial_current_url', '$session_entry_url', '$session_entry_current_url'];
var URL_KEY = /(url|href|action|src)$/i;
var REFERRER_KEY = /referrer$/i;
var OPAQUE_SCHEME = /^(mailto|tel|sms|javascript|data|blob):/i;
var MAX_DEPTH = 10;
var PATHNAME_KEY = /pathname$/i;
var PREV_PATHNAME = '$prev_pageview_pathname';

// gh-3357 (from the #3352 heatmap check): heatmaps are off today only because HeyCatch's config says so
// ("heatmaps": false), and HeyCatch can change that for every customer. The SDK would send the click and
// scroll buffer as an event named "$$heatmap" with a "$heatmap_data" property. Drop both here so the
// #3352 protection does not depend on their setting.
var HEATMAP_EVENT = '$$heatmap';
var HEATMAP_PROP = '$heatmap_data';

// The one value rule for a kept campaign value, in a URL or as a standalone property: 1 to 100
// characters, and no "@" (or fullwidth "@") at any level of percent-decoding, so "x%2540y.com" is caught.
function valueOk(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_KEPT_VALUE) return false;
  var cur = raw;
  for (var i = 0; i < 5; i++) {
    if (/[@\uFF20]/.test(cur)) return false;
    var next;
    try { next = decodeURIComponent(cur.replace(/\+/g, ' ')); } catch (e) { return false; }
    if (next === cur) return true;
    cur = next;
  }
  return !/[@\uFF20]/.test(cur);
}

function keepPair(pair) {
  var eq = pair.indexOf('=');
  var rawKey = eq < 0 ? pair : pair.slice(0, eq);
  var rawVal = eq < 0 ? '' : pair.slice(eq + 1);
  var key;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch (e) {
    return false;
  }
  if (KEEP_KEYS.indexOf(key) === -1) return false;
  return valueOk(rawVal);
}

// The SDK also sends campaign parameters as standalone properties: utm_term, $initial_utm_term,
// $session_entry_utm_term, also inside $set_once. The five UTM keys follow the value rule above and are
// dropped when it fails; every other campaign key the URL rule drops is dropped here too, as is
// ph_keyword (the search query the SDK lifts out of a search-engine referrer's query string).
var CAMPAIGN_DROP = ['gad_source', 'mc_cid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'twclid', 'li_fat_id', 'igshid', 'ttclid', 'rdt_cid', 'epik', 'qclid', 'sccid', 'irclid', '_kx', 'ph_keyword'];
function campaignBase(key) {
  return key.replace(/^\$(?:initial_|session_entry_)/, '');
}

export function scrubUrl(value, keepAttribution) {
  if (typeof value !== 'string') return value;
  var m = OPAQUE_SCHEME.exec(value);
  if (m) return m[0];
  var s = value;
  var h = s.indexOf('#');
  if (h !== -1) s = s.slice(0, h);
  var q = s.indexOf('?');
  if (q === -1) return s;
  var base = s.slice(0, q);
  if (!keepAttribution) return base;
  var kept = s.slice(q + 1).split('&').filter(keepPair);
  return kept.length ? base + '?' + kept.join('&') : base;
}

// Referrer properties: ORIGIN ONLY. A referrer path can name a signed-in page ("/bids.html") or carry a
// claim id ("/contractor/bid/<claimId>"), so no path, query or fragment is sent. "$direct" passes through;
// a value that is not an http(s) URL is dropped (undefined).
export function scrubReferrer(value) {
  if (typeof value !== 'string') return value;
  if (value === '$direct') return value;
  try {
    var u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.origin;
  } catch (e) {
    return undefined;
  }
}

function scrubChain(chain) {
  return chain.replace(/((?:attr__)?(?:href|action|src)=")((?:[^"\\]|\\.)*)"/g, function (all, head, val) {
    return head + scrubUrl(val, false) + '"';
  });
}

// The path of an absolute URL, or null when it does not parse (so a pathAllowed check fails closed).
function urlPath(v) {
  try { return new URL(v).pathname; } catch (e) { return null; }
}

function isPlain(v) {
  var p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function walk(v, key, depth, pathOk) {
  if (depth > MAX_DEPTH) return undefined;
  if (key === HEATMAP_PROP) return undefined;
  if (key) {
    var base = campaignBase(key);
    if (CAMPAIGN_DROP.indexOf(base) !== -1) return undefined;
    if (KEEP_KEYS.indexOf(base) !== -1 && v !== null && v !== undefined && !valueOk(v)) return undefined;
  }
  if (typeof v === 'string') {
    if (key === '$elements_chain') return scrubChain(v);
    if (pathOk && key && PATHNAME_KEY.test(key) && pathOk(v) !== true) return undefined;
    if (pathOk && CURRENT_URL_KEYS.indexOf(key) !== -1 && pathOk(urlPath(v)) !== true) return undefined;
    if (key && REFERRER_KEY.test(key)) return scrubReferrer(v);
    if (key && URL_KEY.test(key)) return scrubUrl(v, CURRENT_URL_KEYS.indexOf(key) !== -1);
    return v;
  }
  if (Array.isArray(v)) {
    return v.map(function (x) { return walk(x, key, depth + 1, pathOk); });
  }
  if (v && typeof v === 'object' && isPlain(v)) {
    var out = {};
    Object.keys(v).forEach(function (k) {
      var r = walk(v[k], k, depth + 1, pathOk);
      if (r !== undefined) out[k] = r;
    });
    return out;
  }
  return v;
}

// Returns a scrubbed copy of the event, or null if it cannot be scrubbed. Never throws.
// Covers event.properties (which holds the session-entry values the SDK stores and
// re-adds to every event), event.$set and event.$set_once (which hold the initial_*
// values) and autocapture elements, because it walks the whole event.
// pathAllowed (optional, gh-3357): see the header. A pathAllowed that throws drops the event.
export function scrubEvent(event, pathAllowed) {
  try {
    if (!event || typeof event !== 'object') return null;
    if (event.event === HEATMAP_EVENT) return null;
    var pathOk = typeof pathAllowed === 'function' ? pathAllowed : null;
    var out = walk(event, '', 0, pathOk);
    var p = out && out.properties;
    if (!pathOk && p && typeof p === 'object' && PREV_PATHNAME in p && p[PREV_PATHNAME] !== p.$pathname) delete p[PREV_PATHNAME];
    return out;
  } catch (e) {
    return null;
  }
}

// gate: optional function returning false to drop the event (the app uses it for its route check).
// pathAllowed: optional page predicate for path properties (gh-3357, see the header).
// The SDK calls beforeSend without a try/catch, so this must never throw: a failure drops the event.
export function makeBeforeSend(gate, pathAllowed) {
  return function (event) {
    try {
      if (gate && !gate()) return null;
      return scrubEvent(event, pathAllowed);
    } catch (e) {
      return null;
    }
  };
}

// gh-3352 item 2: the SDK's toolbar loader (maybeLoadToolbar, 0.8.3) runs inside init()
// and fetches in.heycatch.ai/static/toolbar.js when ANY of these is present:
//   - location.hash contains "__posthog=" or "state=" (matched anywhere in the hash)
//     with a base64 or JSON {action:"ph_authorize", token: <public token>} value. The
//     SDK reads the hash twice: once when its module is evaluated (a module-level
//     constant, so clearing the hash after import is too late) and once inside init().
//   - localStorage._postHogToolbarParams holds {token: <public token>} from an earlier
//     visit (an earlier crafted link writes it).
// 0.8.3 has no config option that turns the toolbar off. The only switch is the
// internal instance name "ph_toolbar_internal", which is not a supported setting.
// So: remove both triggers before the SDK is imported, and put the hash back after init.
var STORED_KEY = '_postHogToolbarParams';
var HASH_TRIGGER = /__posthog=|state=/;

export function clearStoredToolbarParams() {
  try { window.localStorage.removeItem(STORED_KEY); } catch (e) { /* storage blocked */ }
  try { window.sessionStorage.removeItem(STORED_KEY); } catch (e) { /* storage blocked */ }
}

// Call BEFORE importing the SDK. Returns { restore } when it is safe to load the SDK, or
// null when a trigger is in the address and could not be removed (the caller must not load the SDK).
export function hideToolbarTrigger() {
  clearStoredToolbarParams();
  var hash = '';
  try { hash = window.location.hash || ''; } catch (e) { return null; }
  if (!HASH_TRIGGER.test(hash)) return { restore: function () { clearStoredToolbarParams(); } };
  var base = window.location.pathname + window.location.search;
  try {
    window.history.replaceState(window.history.state, '', base);
  } catch (e) {
    return null;
  }
  if (HASH_TRIGGER.test(window.location.hash || '')) return null;
  return {
    restore: function () {
      clearStoredToolbarParams();
      try {
        // Only if nothing moved the page in the meantime.
        if (window.location.hash === '' && window.location.pathname + window.location.search === base) {
          window.history.replaceState(window.history.state, '', base + hash);
        }
      } catch (e) { /* leave the address without the fragment */ }
    }
  };
}

// gh-3389 (D-409): the ONE custom event HeyCatch may receive from the marketing site. Name-allowlisted and sent with
// NO properties: the tracker takes a name and nothing else, so a caller cannot attach a lead id, event id, step,
// email or any other value even by mistake. Anything not on the list is dropped. The page gate
// (HEYCATCH_ALLOWED_PATHS in js/ga-gate.js) is untouched; this only runs where the SDK was already loaded.
var TRACKABLE_EVENTS = ['lead_saved'];
export function makeEventTracker(trackEvent) {
  return function (name) {
    if (TRACKABLE_EVENTS.indexOf(name) === -1) return false;
    try { trackEvent(name); return true; } catch (e) { return false; }
  };
}
