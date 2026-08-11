/**
 * OtterQuote — Shared Supabase client-init guard (#448).
 *
 * Replaces the 47 scattered `if (!sb) return;` early-returns across 15 pages.
 * Those guards were true patch-fatigue: same defensive check, copy-pasted
 * per function, that fails completely silently — a user whose CDN load of
 * supabase-js failed (network blip, ad-blocker, CDN outage) sees dead
 * buttons with zero feedback. `sb` itself is still built by js/config.js
 * (unchanged); this module only centralizes what happens when it isn't.
 */
var SupabaseClient = {
  _warned: false,

  /**
   * Call at the top of any function that used to do `if (!sb) return;`.
   * Returns the live client (truthy) when ready — identical success-path
   * behavior to the old guard. On failure, surfaces one visible banner per
   * page load (not once per call) instead of silently doing nothing, then
   * returns null so the caller's existing `if (!X) return;` still works.
   */
  require() {
    if (typeof sb !== 'undefined' && sb) return sb;
    if (!this._warned) {
      this._warned = true;
      console.error('[SupabaseClient] sb is not initialized — supabase-js failed to load or config.js did not run.');
      this._showBanner();
    }
    return null;
  },

  _showBanner() {
    if (document.getElementById('sbClientErrorBanner')) return;
    var bar = document.createElement('div');
    bar.id = 'sbClientErrorBanner';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:sticky;top:0;z-index:9999;background:#B91C1C;color:#fff;' +
      'font:600 0.85rem/1.4 var(--font-body, sans-serif);text-align:center;padding:8px 12px;';
    bar.textContent = 'Connection error — please refresh the page. If this continues, check your network or disable ad-blockers for this site.';
    document.body.insertBefore(bar, document.body.firstChild);
  },
};
