/**
 * gh-2046 — the React /get-started page's Sentry client sends the `lead`
 * query-param value to Sentry even after the early-strip head script has
 * removed it from `document.location`. It survives inside the pageload
 * transaction's browser-timing spans (domContentLoadedEvent, loadEvent,
 * connect, TLS/SSL, cache, DNS, request, response): their `description`
 * and `data` are copied from the Navigation Timing / Resource Timing
 * entries, which capture the *original* URL the page was requested with
 * and are unaffected by `history.replaceState`.
 *
 * This module is the single place that decides what "contains the lead
 * id" means and how to neutralize it, so `SentryInitializer` can apply it
 * uniformly to every Sentry hook (`beforeSend`, `beforeSendTransaction`,
 * `beforeBreadcrumb`) instead of enumerating fields by hand — a new span
 * type or a future `data.foo.url` shape gets covered for free.
 *
 * The value is replaced, not dropped: transactions/spans/breadcrumbs stay
 * intact for debugging, they just never leave this origin carrying a
 * homeowner's lead id.
 */

export const LEAD_REDACTED_TOKEN = "[redacted]";

// Matches `lead=<value>` as a URL query/fragment parameter: after a literal
// `?`, `&` or `#`, case-insensitive `lead=`, up to (not including) the next
// `&`, whitespace, quote, or angle bracket. Deliberately does NOT match
// `lead` used as a bare word or as part of another key name (e.g.
// `leadSource=`) because it requires the `?`/`&`/`#` boundary directly
// before `lead=`.
const LEAD_PARAM_RE = /([?&#]lead=)([^&#\s"'<>]+)/gi;

/**
 * Redacts every `lead=<value>` occurrence in a string, wherever it appears
 * (a full URL, a URL fragment embedded in prose, a span description that
 * quotes a URL, etc.). Strings with no match are returned unchanged
 * (same reference) so this is cheap to call on every string in an event.
 */
export function redactLeadParam(value: string): string {
  if (typeof value !== "string" || value.indexOf("lead=") === -1) {
    return value;
  }
  return value.replace(LEAD_PARAM_RE, `$1${LEAD_REDACTED_TOKEN}`);
}

/**
 * Recursively walks any JSON-shaped value (Sentry events, transactions,
 * spans, breadcrumbs are all plain objects/arrays/strings/primitives by
 * the time they reach these hooks) and redacts `lead=` occurrences in
 * every string it finds. Objects/arrays are only cloned when something
 * inside them actually changes, so unrelated event fields keep their
 * original identity.
 */
export function redactLeadDeep<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === "string") {
    return redactLeadParam(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactLeadDeep(item, seen);
      if (redacted !== item) changed = true;
      return redacted;
    });
    return (changed ? next : value) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as unknown as object;
    if (seen.has(obj)) return value;
    seen.add(obj);
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const redacted = redactLeadDeep(val, seen);
      if (redacted !== val) changed = true;
      next[key] = redacted;
    }
    return (changed ? next : value) as unknown as T;
  }
  return value;
}
