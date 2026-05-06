/**
 * OtterQuote Cookie Storage Adapter — D-212
 * 
 * Provides Supabase JS v2 with a custom storage adapter that writes sessions
 * to cookies scoped to .otterquote.com, enabling SSO between otterquote.com
 * and app.otterquote.com (D-212).
 * 
 * Migration strategy: getItem reads cookies first, falls back to localStorage.
 * setItem dual-writes to both. This ensures existing localStorage sessions
 * continue to work transparently — no users are logged out on deploy.
 * 
 * IMPORTANT: Load this script BEFORE config.js in all HTML files.
 */

(function () {
  'use strict';

  // Key used by Supabase JS v2 for auth token storage
  // Format: sb-{projectRef}-auth-token
  var SUPABASE_STORAGE_KEY_PREFIX = 'sb-';

  /**
   * Parse Max-Age from a Supabase session JSON value.
   * Extracts the JWT exp claim to set cookie expiry to match token expiry.
   * Falls back to 1 hour if parsing fails.
   */
  function getMaxAgeFromSession(value) {
    try {
      var parsed = JSON.parse(value);
      if (parsed && parsed.access_token) {
        var parts = parsed.access_token.split('.');
        if (parts.length === 3) {
          var payload = JSON.parse(atob(parts[1]));
          if (payload && payload.exp) {
            var remaining = payload.exp - Math.floor(Date.now() / 1000);
            return Math.max(0, remaining);
          }
        }
      }
    } catch (e) {
      // ignore parse errors
    }
    return 3600; // default 1 hour
  }

  /**
   * Build the cookie domain attribute.
   * Uses .otterquote.com for production, no domain for localhost/staging previews.
   */
  function getCookieDomain() {
    var host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return ''; // no domain restriction for local dev
    }
    if (host.endsWith('.otterquote.com') || host === 'otterquote.com') {
      return '; Domain=.otterquote.com';
    }
    return ''; // Netlify preview URLs — no cross-domain needed
  }

  /**
   * Build Secure flag — only for HTTPS connections.
   */
  function getSecureFlag() {
    return window.location.protocol === 'https:' ? '; Secure' : '';
  }

  /**
   * Read a cookie by name. Returns null if not found.
   */
  function readCookie(key) {
    var pairs = document.cookie.split('; ');
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i];
      var eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      var cookieName = pair.substring(0, eqIdx);
      if (cookieName === key) {
        return decodeURIComponent(pair.substring(eqIdx + 1));
      }
    }
    return null;
  }

  /**
   * OtterQuote Cookie Storage — implements the localStorage-compatible interface
   * expected by Supabase JS v2's storage option.
   */
  window.OtterQuoteCookieStorage = {
    getItem: function (key) {
      // Read cookie first (canonical source once set), fall back to localStorage
      var cookieVal = readCookie(key);
      if (cookieVal !== null) {
        return cookieVal;
      }
      // Fallback: transparent migration from existing localStorage sessions
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },

    setItem: function (key, value) {
      // Dual-write: cookie (cross-subdomain) + localStorage (migration safety net)
      var maxAge = getMaxAgeFromSession(value);
      var domain = getCookieDomain();
      var secure = getSecureFlag();
      document.cookie = key + '=' + encodeURIComponent(value) +
        '; Path=/' +
        domain +
        '; Max-Age=' + maxAge +
        '; SameSite=Lax' +
        secure;
      try {
        window.localStorage.setItem(key, value);
      } catch (e) {
        // localStorage unavailable — cookie is sufficient
      }
    },

    removeItem: function (key) {
      // Expire the cookie
      var domain = getCookieDomain();
      document.cookie = key + '=; Path=/' + domain + '; Max-Age=0; SameSite=Lax';
      try {
        window.localStorage.removeItem(key);
      } catch (e) {
        // ignore
      }
    }
  };

})();
