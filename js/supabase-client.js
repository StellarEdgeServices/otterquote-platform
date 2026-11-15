/**
 * OtterQuote — Shared Supabase client init (GitHub #448)
 *
 * Replaces the per-page `let sb = null; function initSupabase() {...}` +
 * `if (!sb) return` guard pattern duplicated across 15 pages (47 guards
 * total). Classic <script> tags execute synchronously in document order, so
 * as long as this file is included after js/config.js (for CONFIG) and the
 * Supabase CDN script (for window.supabase) and before any page code that
 * reads `sb`, window.sb is guaranteed to be a live client by the time any
 * later script — including js/auth.js and each page's inline script — runs.
 * That guarantee is what lets the old null-checks be deleted rather than
 * consolidated: there is no longer a window where `sb` can be read before
 * it's set.
 *
 * Idempotency guard (GitHub #448, gh-448 A3 ruling): if window.sb already
 * exists, reuse it and skip creating a second client. A second
 * createClient() call on a page that already has one is the exact class of
 * race that caused a prior magic-link/OAuth getSession() hang (D-208
 * sister fix) -- this guard makes that invariant enforceable by code
 * instead of by a warning comment on individual pages.
 */
(function () {
  if (window.sb) {
    return;
  }
  var factory = window.supabase && window.supabase.createClient;
  if (!factory || typeof CONFIG === 'undefined' || !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON) {
    // Same failure shape as the old per-page guards: leave window.sb unset
    // so a misconfigured page fails loudly (sb.from(...) throws) instead of
    // silently no-op'ing on every guarded call.
    return;
  }
  // gh-3704 (Sentry JAVASCRIPT-3T): supabase-js@2.116.0's GoTrueClient constructor fires
  // initialize() without a .catch. In a browser where Error instances come back
  // non-extensible (seen once: Chrome 138 / Windows, a patched or locked-down Error),
  // AuthError's `this.__isAuthError = true` throws "Cannot add property __isAuthError,
  // object is not extensible" inside _initialize's catch, so the init promise rejects with
  // nobody listening. The throw is in vendor code we load from the CDN, so we cannot fix it
  // at the source. CEO ruling (RUN 152): do NOT swallow it -- the original init error is
  // lost inside that catch, so this may hide a real auth-init failure. Instead: preventDefault
  // (no longer an unhandled TypeError) and report ONE handled warning to Sentry, with a stable
  // fingerprint, the message prefix and the browser UA (no PII, no tokens). Registered in the
  // CAPTURE phase BEFORE createClient() so it runs ahead of Sentry's own unhandledrejection
  // listener; matched narrowly (TypeError + message prefix + a supabase frame).
  if (typeof window.addEventListener === 'function') {
    var gh3704Reported = false;
    window.addEventListener('unhandledrejection', function (ev) {
      var r = ev && ev.reason;
      if (!r || r.name !== 'TypeError' || typeof r.message !== 'string') return;
      if (r.message.indexOf('Cannot add property __isAuthError') !== 0) return;
      if (String(r.stack || '').indexOf('supabase') === -1) return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
      if (gh3704Reported) return;
      gh3704Reported = true;
      try {
        var S = window.Sentry;
        if (S && typeof S.captureMessage === 'function') {
          S.captureMessage('supabase-js init: Cannot add property __isAuthError (non-extensible Error)', {
            level: 'warning',
            fingerprint: ['gh3704-supabase-auth-init-nonextensible'],
            tags: { gh: '3704', handled: 'yes' },
            contexts: { gh3704: { userAgent: (window.navigator && window.navigator.userAgent) || 'unknown' } },
          });
        }
      } catch (_) {}
    }, true);
  }
  window.sb = factory(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON, {
    auth: {
      storage: window.OtterQuoteCookieStorage,
      storageKey: window.OTTERQUOTE_AUTH_STORAGE_KEY || 'sb-otterquote-auth',
      // gh-1980 PR 3/3 (Google-only PKCE): implicit unless this page load is a
      // verifier-backed Google ?code= return -- see js/cookie-storage.js.
      flowType: (window.OtterQuoteOAuthPkce ? window.OtterQuoteOAuthPkce.flowTypeForPageLoad() : 'implicit'),
    },
  });
})();
