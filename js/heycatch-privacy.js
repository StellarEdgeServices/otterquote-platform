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
//     has no "@": utm_source, utm_medium, utm_campaign, utm_content, utm_term.
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
//   Left alone: $pathname, $host, $referring_domain, $prev_pageview_pathname,
//     $session_entry_pathname and the other path or host-only properties. They
//     carry no query.
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

function keepPair(pair) {
  var eq = pair.indexOf('=');
  var rawKey = eq < 0 ? pair : pair.slice(0, eq);
  var rawVal = eq < 0 ? '' : pair.slice(eq + 1);
  var key;
  var val;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    val = decodeURIComponent(rawVal.replace(/\+/g, ' '));
  } catch (e) {
    return false;
  }
  if (KEEP_KEYS.indexOf(key) === -1) return false;
  return val.length > 0 && val.length <= MAX_KEPT_VALUE && val.indexOf('@') === -1;
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

function isPlain(v) {
  var p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function walk(v, key, depth) {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof v === 'string') {
    if (key === '$elements_chain') return scrubChain(v);
    if (key && REFERRER_KEY.test(key)) return scrubReferrer(v);
    if (key && URL_KEY.test(key)) return scrubUrl(v, CURRENT_URL_KEYS.indexOf(key) !== -1);
    return v;
  }
  if (Array.isArray(v)) {
    return v.map(function (x) { return walk(x, key, depth + 1); });
  }
  if (v && typeof v === 'object' && isPlain(v)) {
    var out = {};
    Object.keys(v).forEach(function (k) {
      var r = walk(v[k], k, depth + 1);
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
export function scrubEvent(event) {
  try {
    if (!event || typeof event !== 'object') return null;
    return walk(event, '', 0);
  } catch (e) {
    return null;
  }
}

// gate: optional function returning false to drop the event (the app uses it for its route check).
// The SDK calls beforeSend without a try/catch, so this must never throw: a failure drops the event.
export function makeBeforeSend(gate) {
  return function (event) {
    try {
      if (gate && !gate()) return null;
      return scrubEvent(event);
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
