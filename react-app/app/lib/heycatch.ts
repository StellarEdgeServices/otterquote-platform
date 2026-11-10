/**
 * HeyCatch trial (CEO RUN 144). Loaded only through HeyCatchGate.
 *
 * Identity is deliberately NOT sent: agents.md asks for email and name on
 * setIdentity, which is a Tier C call for Dustin on a trial vendor.
 */
import type { analytics as HeyCatchAnalytics } from "@heycatch/sdk";
import { hideToolbarTrigger, makeBeforeSend } from "./heycatch-privacy";

export const HEYCATCH_ALLOWED_PATHS = ["/get-started"];

export function isHeyCatchAllowedPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return HEYCATCH_ALLOWED_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign"];

/**
 * SDK 0.8.3 strips these three params one second after init on ANY link with
 * utm_campaign, not only its own short links. get-started reads utm_source
 * again at sign-up, so a homeowner from an ad would be recorded as "direct".
 * Puts back what it removed. Exported for the test.
 */
export function restoreStrippedUtm(kept: Record<string, string>): void {
  const now = new URLSearchParams(window.location.search);
  let changed = false;
  for (const [k, v] of Object.entries(kept)) {
    if (now.get(k) === null) {
      now.set(k, v);
      changed = true;
    }
  }
  if (changed) {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}?${now.toString()}${window.location.hash}`,
    );
  }
}

export function utmToKeep(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  if (params.get("utm_campaign") === null || params.get("utm_source") === "heycatch") return {};
  const kept: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = params.get(k);
    if (v !== null) kept[k] = v;
  }
  return kept;
}

let sdk: typeof HeyCatchAnalytics | null = null;
let loading: Promise<void> | null = null;

export function loadHeyCatch(): Promise<void> {
  if (loading) return loading;
  const kept = utmToKeep(window.location.search);
  // gh-3352: the SDK reads location.hash when its module is evaluated, so the toolbar triggers
  // (a `__posthog=` or `state=` fragment, stored _postHogToolbarParams) are removed BEFORE the import.
  const guard = hideToolbarTrigger();
  if (!guard) return (loading = Promise.resolve());
  loading = import("@heycatch/sdk")
    .then(({ analytics }) => {
      analytics.init({
        projectKey: "hck_pk_EDCHqNmpbCRmDWZD6PCDsAEczZa0eWr6",
        requestBatching: false,
        install: { framework: "nextjs", frameworkVersion: "16", agent: "claude-code" },
        // A client-side move off an allowed route must not keep reporting. Every URL-bearing
        // property loses its query string and fragment (gh-3352); see heycatch-privacy.ts.
        // gh-3357: the second argument drops any path property that names a route off the
        // allowlist, e.g. $prev_pageview_pathname "/contractor/bid/<claimId>" after a client-side move.
        beforeSend: makeBeforeSend(() => isHeyCatchAllowedPath(window.location.pathname), isHeyCatchAllowedPath),
      });
      sdk = analytics;
      guard.restore();
      if (Object.keys(kept).length) setTimeout(() => restoreStrippedUtm(kept), 1100);
    })
    .catch(() => guard.restore());
  return loading;
}

/** No-op unless the gate loaded the SDK. */
export function trackSignupCompleted(method: "google" | "password"): void {
  sdk?.trackEvent("signup_completed", { method });
}
