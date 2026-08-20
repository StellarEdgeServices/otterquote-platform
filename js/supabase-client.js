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
  window.sb = factory(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON, {
    auth: {
      storage: window.OtterQuoteCookieStorage,
      storageKey: window.OTTERQUOTE_AUTH_STORAGE_KEY || 'sb-otterquote-auth',
    },
  });
})();
