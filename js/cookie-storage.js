/**
 * OtterQuote Cookie Storage Adapter v2 — D-212 cross-subdomain SSO fix
 * ClickUp 86e1bpk7b — Bug fix May 12, 2026
 *
 * Token-only cookie pattern. Extracts access_token + refresh_token from the
 * Supabase session JSON and writes them to two small cookies scoped to
 * .otterquote.com. The full session is reconstructed on read.
 *
 * Why this exists:
 *   v1 wrote the full session JSON (3796 raw / 4676 URL-encoded bytes) via
 *   document.cookie. That exceeds Chrome's per-cookie 4096-byte limit and
 *   the browser silently dropped the write. Only localStorage held the
 *   session, and localStorage is origin-scoped — so cross-subdomain SSO
 *   between otterquote.com and app.otterquote.com was broken for any user
 *   who logged in on one and traversed to the other.
 *
 * Architecture:
 *   - sb-otterquote-at  : access token (~900 URL-encoded bytes)
 *   - sb-otterquote-rt  : refresh token (~900 URL-encoded bytes)
 *   - Both at Domain=.otterquote.com; cross all *.otterquote.com hosts
 *   - localStorage dual-write under canonical key (sb-otterquote-auth) for
 *     same-origin fast-path reads and as a safety net if cookies are blocked
 *   - Transparent migration: getItem falls back to legacy keys so existing
 *     contractor sessions and pre-fix React app sessions are preserved
 *   - Write verification guard: after writing each cookie, reads it back
 *     and logs a warning if the browser silently dropped it. This catches
 *     the entire class of silent-drop failures that hid the v1 bug for months
 *
 * Used by:
 *   - Static stack (js/config.js) — wired via createClient { auth: { storage } }
 *   - React stack (react-app/app/lib/cookie-storage.ts) — TypeScript port
 *
 * Load order: BEFORE config.js in every HTML file that loads the Supabase client.
 */

(function () {
  'use strict';

  // Canonical storage key — both stacks agree on this name so SSO works.
  // Exposed for use by auth.js fast-path existence checks.
  var STORAGE_KEY = 'sb-otterquote-auth';
  window.OTTERQUOTE_AUTH_STORAGE_KEY = STORAGE_KEY;

  // Cookie names for the token-only cross-subdomain pattern.
  var COOKIE_ACCESS  = 'sb-otterquote-at';
  var COOKIE_REFRESH = 'sb-otterquote-rt';

  // Legacy storage keys consulted for purge + cookie-less fallback.
  // #488 follow-up: this file loads BEFORE config.js, so the project-ref key
  // MUST be computed lazily (at call time) — the old load-time IIFE never saw
  // CONFIG, the project-ref key never joined the list, and sign-out left a
  // resurrection seed in localStorage.
  function legacyKeys() {
    var keys = ['sb_at'];
    try {
      // Pattern scan instead of CONFIG-derivation: catches every Supabase
      // default-storage key regardless of script load order or environment.
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (k && /^sb-[a-z0-9]+-auth-token$/.test(k)) keys.push(k);
      }
    } catch (e) { /* localStorage blocked */ }
    return keys;
  }

  /** Parse a Supabase session JSON. Returns null if not a valid session. */
  function parseSession(jsonStr) {
    if (typeof jsonStr !== 'string' || !jsonStr) return null;
    try {
      var parsed = JSON.parse(jsonStr);
      if (!parsed || typeof parsed !== 'object') return null;
      if (!parsed.access_token || !parsed.refresh_token) return null;
      var expSec = parsed.expires_at || null;
      if (!expSec) {
        var parts = parsed.access_token.split('.');
        if (parts.length === 3) {
          try {
            var payload = JSON.parse(atob(parts[1]));
            if (payload && payload.exp) expSec = payload.exp;
          } catch (e) { /* invalid JWT */ }
        }
      }
      return { access: parsed.access_token, refresh: parsed.refresh_token, expSec: expSec };
    } catch (e) {
      return null;
    }
  }

  /**
   * Reconstruct a Supabase session JSON string from access + refresh tokens.
   *
   * D-212 fix May 13, 2026 — populate the user object from JWT claims at
   * reconstruction time. Previous version set user:null on the assumption
   * Supabase would auto-fetch via getUser(); in practice, pages reading
   * session.user.id directly on init (e.g. contractor-bid-form.html) got
   * null and redirected to login. Decoding the JWT payload locally fills
   * the same fields Supabase would have written.
   */
  function reconstructSession(accessToken, refreshToken) {
    var expSec = null;
    var expiresIn = null;
    var user = null;
    try {
      var parts = accessToken.split('.');
      if (parts.length === 3) {
        var payload = JSON.parse(atob(parts[1]));
        if (payload) {
          if (payload.exp) {
            expSec = payload.exp;
            expiresIn = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
          }
          if (payload.sub) {
            var iatIso = payload.iat ? new Date(payload.iat * 1000).toISOString() : null;
            user = {
              id: payload.sub,
              email: payload.email || null,
              aud: payload.aud || 'authenticated',
              role: payload.role || 'authenticated',
              app_metadata: payload.app_metadata || {},
              user_metadata: payload.user_metadata || {},
              email_confirmed_at: payload.email_verified ? iatIso : null,
              phone: payload.phone || '',
              confirmed_at: payload.email_verified ? iatIso : null,
              last_sign_in_at: iatIso,
              created_at: iatIso,
              updated_at: iatIso,
              identities: payload.user_metadata && payload.user_metadata.identities ? payload.user_metadata.identities : []
            };
          }
        }
      }
    } catch (e) { /* invalid JWT — leave nulls */ }

    return JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expSec,
      expires_in: expiresIn,
      token_type: 'bearer',
      user: user
    });
  }

  /** Cookie Max-Age — outlive the access token so refresh can rotate it. */
  function getCookieMaxAge(expSec) {
    // gh-867: Supabase imposes no session time-box on this project (0 of
    // 26,396 session rows carry a not_after value) and refresh-token
    // rotation is healthy well past a week — the prior 7-day default was a
    // self-imposed cap with no backend requirement behind it, forcing weekly
    // magic-link re-auth. 400 days is Chrome's Max-Age ceiling (anything
    // larger is silently clamped); this does not invalidate existing
    // sessions — they pick up the longer window on their next token refresh.
    var defaultSec = 400 * 24 * 3600; // 400 days — Chrome's Max-Age ceiling
    if (!expSec) return defaultSec;
    var remaining = expSec - Math.floor(Date.now() / 1000);
    return Math.max(3600, Math.max(remaining, defaultSec));
  }

  /** Domain attribute — leading dot for cross-subdomain sharing. */
  function getCookieDomain() {
    if (typeof window === 'undefined') return '';
    var host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return '';
    if (host.endsWith('.otterquote.com') || host === 'otterquote.com') {
      return '; Domain=.otterquote.com';
    }
    return ''; // Netlify preview URLs — no cross-domain
  }

  function getSecureFlag() {
    if (typeof window === 'undefined') return '';
    return window.location.protocol === 'https:' ? '; Secure' : '';
  }

  function readCookie(key) {
    if (typeof document === 'undefined' || !document.cookie) return null;
    var pairs = document.cookie.split('; ');
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i];
      var eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      if (pair.substring(0, eqIdx) === key) {
        try { return decodeURIComponent(pair.substring(eqIdx + 1)); }
        catch (e) { return null; }
      }
    }
    return null;
  }

  function writeCookie(key, value, maxAge) {
    if (typeof document === 'undefined') return;
    var domain = getCookieDomain();
    var secure = getSecureFlag();
    document.cookie = key + '=' + encodeURIComponent(value) +
      '; Path=/' + domain +
      '; Max-Age=' + maxAge +
      '; SameSite=Lax' + secure;
  }

  function deleteCookie(key) {
    if (typeof document === 'undefined') return;
    var domain = getCookieDomain();
    document.cookie = key + '=; Path=/' + domain + '; Max-Age=0; SameSite=Lax';
    // Also clear any host-only same-named cookie from a prior version.
    document.cookie = key + '=; Path=/; Max-Age=0; SameSite=Lax';
  }

  /**
   * Write-verification guard: after writing a cookie, read it back and log
   * loudly if the browser dropped it silently. Stage 5 prevention for the
   * silent-drop class of bug. Does not throw — Supabase doesn't expect
   * setItem to throw — but surfaces the failure to console + monitoring.
   */
  function verifyWrite(key, expected, label) {
    var actual = readCookie(key);
    if (actual === null) {
      try {
        console.warn('[OtterQuoteCookieStorage] write verification FAILED for ' + key +
          ' (' + label + '). Cookie was silently dropped by the browser. ' +
          'Likely cause: size > 4096 bytes, blocked cookie, or browser policy. ' +
          'Token length: ' + (expected ? expected.length : 0) + ' chars. ' +
          'Falling back to localStorage; cross-subdomain SSO will fail.');
      } catch (e) { /* console may be unavailable */ }
      return false;
    }
    return true;
  }

  function readLegacy(callerKey) {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    try {
      var direct = window.localStorage.getItem(callerKey);
      if (direct) return direct;
      var lk = legacyKeys();
      for (var i = 0; i < lk.length; i++) {
        var v = window.localStorage.getItem(lk[i]);
        if (v) return v;
      }
    } catch (e) { /* localStorage blocked */ }
    return null;
  }

  // #488 — cookie-usability probe (memoized per page load). When cookies are
  // blocked entirely the cookie cannot be canonical and localStorage remains
  // the only viable store; everywhere else, absent cookies mean signed out.
  var _cookiesUsable = null;
  function cookiesUsable() {
    if (_cookiesUsable !== null) return _cookiesUsable;
    try {
      document.cookie = 'oq-cookie-probe=1; Path=/; Max-Age=60; SameSite=Lax';
      _cookiesUsable = document.cookie.indexOf('oq-cookie-probe=') !== -1;
      document.cookie = 'oq-cookie-probe=; Path=/; Max-Age=0; SameSite=Lax';
    } catch (e) { _cookiesUsable = false; }
    return _cookiesUsable;
  }

  /**
   * Storage adapter implementing the localStorage-compatible interface
   * expected by Supabase JS v2's `storage` option.
   */
  window.OtterQuoteCookieStorage = {
    getItem: function (key) {
      // 1. Try canonical two-cookie format — cross-subdomain mechanism
      var at = readCookie(COOKIE_ACCESS);
      var rt = readCookie(COOKIE_REFRESH);
      if (at && rt) return reconstructSession(at, rt);

      // 2. Cookies are canonical (#488). If BOTH cookies are absent the user
      // is signed out — the per-origin localStorage copy must never resurrect
      // the session (or rewrite the domain-wide cookies): that silently signed
      // users back in as the previous account after a sign-out on the other
      // subdomain. Purge local copies so sign-out sticks everywhere. Only a
      // browser that cannot hold cookies at all falls back to localStorage.
      if (cookiesUsable()) {
        try { window.localStorage.removeItem(key); } catch (e) {}
        try {
          var purge = legacyKeys();
          for (var i = 0; i < purge.length; i++) {
            window.localStorage.removeItem(purge[i]);
          }
        } catch (e) {}
        return null;
      }

      // 3. Cookie-less browser fallback — localStorage is the only store left.
      try {
        var stored = window.localStorage.getItem(key);
        if (stored) return stored;
      } catch (e) { /* localStorage blocked */ }
      return readLegacy(key);
    },

    setItem: function (key, value) {
      // Treat empty/null as a clear (Supabase normally uses removeItem,
      // but defensive against future SDK shifts).
      if (value === null || value === undefined || value === '') {
        this.removeItem(key);
        return;
      }
      var session = parseSession(value);
      if (!session) {
        // Unparseable payload — preserve in localStorage; do not write cookies.
        try { window.localStorage.setItem(key, value); } catch (e) {}
        return;
      }
      var maxAge = getCookieMaxAge(session.expSec);

      // Cookies (cross-subdomain mechanism)
      writeCookie(COOKIE_ACCESS,  session.access,  maxAge);
      writeCookie(COOKIE_REFRESH, session.refresh, maxAge);
      verifyWrite(COOKIE_ACCESS,  session.access,  'access_token');
      verifyWrite(COOKIE_REFRESH, session.refresh, 'refresh_token');

      // localStorage (same-origin fast-path + contractor backward-compat)
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },

    removeItem: function (key) {
      deleteCookie(COOKIE_ACCESS);
      deleteCookie(COOKIE_REFRESH);
      try { window.localStorage.removeItem(key); } catch (e) {}
      // Also clear legacy keys so signOut on either subdomain truly logs out.
      try {
        var lk2 = legacyKeys();
        for (var i = 0; i < lk2.length; i++) {
          window.localStorage.removeItem(lk2[i]);
        }
      } catch (e) {}
    }
  };

  /* ─────────────────────────────────────────────────────────────────────
   * Referral attribution bridge — Bridge 2026-08-26 (P0)
   *
   * The referral chain was broken end-to-end and nothing surfaced it:
   *   ref.html (otterquote.com)  writes oq_referral_id / _agent_id / _code
   *                              to localStorage + sessionStorage
   *   trade-selector.html        meta-refreshes to app.otterquote.com
   *   react-app trade-selector   reads those keys from app-origin storage
   *
   * localStorage is ORIGIN-scoped, not domain-scoped, so the app origin read
   * empty every time. `claims.referral_id` was therefore never written, and
   * apply_referral_commission() walks exactly that column — meaning no partner
   * could ever be paid for a referral that converted. The auth tokens already
   * solved this same problem with .otterquote.com cookies (D-212); referral
   * attribution just never got the same treatment.
   *
   * 90 days matches the attribution window the referrals table assumes.
   * ───────────────────────────────────────────────────────────────────── */
  var REFERRAL_KEYS      = ['oq_referral_id', 'oq_referral_agent_id', 'oq_referral_code'];
  var REFERRAL_COOKIE    = 'oq-ref';           // one cookie, JSON payload — all three ids are short
  var REFERRAL_MAX_AGE   = 60 * 60 * 24 * 90;  // 90 days

  window.OtterQuoteReferral = {
    /** Persist referral ids to localStorage, sessionStorage AND a
     *  .otterquote.com cookie so app.otterquote.com can read them. */
    write: function (ids) {
      if (!ids) return;
      var payload = {};
      for (var i = 0; i < REFERRAL_KEYS.length; i++) {
        var k = REFERRAL_KEYS[i];
        var v = ids[k];
        if (v === undefined || v === null || v === '') continue;
        payload[k] = String(v);
        try { window.localStorage.setItem(k, String(v)); } catch (e) {}
        try { window.sessionStorage.setItem(k, String(v)); } catch (e) {}
      }
      if (!Object.keys(payload).length) return;
      try {
        writeCookie(REFERRAL_COOKIE, JSON.stringify(payload), REFERRAL_MAX_AGE);
      } catch (e) {}
    },

    /** Read referral ids, cookie FIRST so a cross-origin hop still resolves.
     *  Returns an object with whichever of the three keys are available. */
    read: function () {
      var out = {};
      try {
        var raw = readCookie(REFERRAL_COOKIE);
        if (raw) {
          var parsed = JSON.parse(raw);
          for (var k in parsed) {
            if (Object.prototype.hasOwnProperty.call(parsed, k)) out[k] = parsed[k];
          }
        }
      } catch (e) {}
      // Same-origin storage fills any gap and wins only where the cookie is silent.
      for (var i = 0; i < REFERRAL_KEYS.length; i++) {
        var key = REFERRAL_KEYS[i];
        if (out[key]) continue;
        try { out[key] = window.sessionStorage.getItem(key) || window.localStorage.getItem(key) || undefined; } catch (e) {}
        if (!out[key]) delete out[key];
      }
      return out;
    },

    /** Clear attribution once it has been stamped onto a claim. */
    clear: function () {
      for (var i = 0; i < REFERRAL_KEYS.length; i++) {
        try { window.localStorage.removeItem(REFERRAL_KEYS[i]); } catch (e) {}
        try { window.sessionStorage.removeItem(REFERRAL_KEYS[i]); } catch (e) {}
      }
      try { deleteCookie(REFERRAL_COOKIE); } catch (e) {}
    },

    _COOKIE: REFERRAL_COOKIE,
    _KEYS:   REFERRAL_KEYS
  };

  // Constants exposed for diagnostics + contract tests.
  window.OtterQuoteCookieStorage._COOKIE_ACCESS   = COOKIE_ACCESS;
  window.OtterQuoteCookieStorage._COOKIE_REFRESH  = COOKIE_REFRESH;
  window.OtterQuoteCookieStorage._STORAGE_KEY     = STORAGE_KEY;
  window.OtterQuoteCookieStorage._getCookieMaxAge = getCookieMaxAge; // gh-867 test hook

})();
