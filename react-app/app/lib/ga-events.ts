/**
 * gh-1984 — GA4 sends that must be handed to gtag.js before the page navigates.
 */

/**
 * gh-1984: send a GA4 event that must survive the redirect that follows it.
 * Measured 2026-09-16 (GA4 realtime, property 541423859): two live test runs
 * of this page produced homeowner_signup x2 but trade_selector_complete x0 —
 * the event fired ~300 ms before `window.location.href` and was dropped.
 * Resolves on gtag's event_callback (the event was handed to gtag.js's
 * transport), or after
 * `timeoutMs` (gtag blocked / not loaded), whichever comes first.
 */
export function gtagEventBeforeNavigation(
  name: string,
  params: Record<string, unknown>,
  timeoutMs = 1000,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    setTimeout(finish, timeoutMs);
    try {
      if (typeof window !== 'undefined' && (window as any).gtag) {
        (window as any).gtag('event', name, {
          ...params,
          event_callback: finish,
          event_timeout: timeoutMs,
        });
      } else {
        finish();
      }
    } catch {
      finish();
    }
  });
}
