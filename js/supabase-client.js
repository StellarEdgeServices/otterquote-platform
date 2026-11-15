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
  // nobody listening -> an unhandled rejection Sentry reports as a new issue. The throw is
  // in vendor code we load from the CDN, so we cannot fix it at the source; we keep this one
  // known environment fault out of Sentry. Registered in the CAPTURE phase BEFORE
  // createClient() so it runs ahead of Sentry's own unhandledrejection listener, and matched
  // narrowly (TypeError + exact message + a supabase frame) so real errors still report.
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('unhandledrejection', function (ev) {
      var r = ev && ev.reason;
      if (!r || r.name !== 'TypeError' || typeof r.message !== 'string') return;
      if (r.message.indexOf('Cannot add property __isAuthError') !== 0) return;
      if (String(r.stack || '').indexOf('supabase') === -1) return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
      try { console.warn('[gh-3704] supabase-js init hit a non-extensible Error; suppressed from Sentry'); } catch (_) {}
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
