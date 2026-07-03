/**
 * GA4 gtag global — D-211 / 86e1z7tn2
 *
 * `gtag.js` (loaded via the Next.js root layout script tag) attaches `gtag`
 * directly onto `window`. This ambient declaration lets pages reference
 * `window.gtag` directly (optional — the tag may not have loaded yet) instead
 * of an untyped `window as any` / non-overlapping-cast workaround.
 */

export {};

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}
