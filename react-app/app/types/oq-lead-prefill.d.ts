/**
 * Router lead-prefill bridge — gh-2046
 *
 * Set by the `beforeInteractive` strip script in app/layout.tsx (see that
 * file's `oq-lead-strip` <Script>) the instant it captures `?lead=<uuid>`
 * off the URL and removes it via history.replaceState, BEFORE any
 * analytics/Sentry initialisation can run. get-started/page.tsx reads this
 * exactly once (see its prefill useEffect) instead of re-parsing
 * location.search, since by the time any React code runs the URL no longer
 * carries `lead` — mirrors the static-page pattern's own
 * window.__oqRouterLeadId bridge (see contractor-join.html and siblings).
 */

export {};

declare global {
  interface Window {
    __oqRouterLeadId?: string;
  }
}
