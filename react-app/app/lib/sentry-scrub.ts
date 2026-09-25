/**
 * gh-2046 — the React /get-started page's Sentry client sends the `lead`
 * query-param value to Sentry even after the early-strip head script has
 * removed it from `document.location`. It survives inside the pageload
 * transaction's browser-timing spans (domContentLoadedEvent, loadEvent,
 * connect, TLS/SSL, cache, DNS, request, response): their `description`
 * and `data` are copied from the Navigation Timing / Resource Timing
 * entries, which capture the *original* URL the page was requested with
 * and are unaffected by `history.replaceState`. It also survives inside
 * Session Replay recording events (a buffered Navigation Timing entry is
 * written into the recording as a performanceSpan) — see gh-2046 M1.
 *
 * This module is the single place that decides what "contains the lead
 * id" means and how to neutralize it, so `SentryInitializer` (and the
 * server/edge Sentry configs) can apply it uniformly to every Sentry hook
 * (`beforeSend`, `beforeSendTransaction`, `beforeBreadcrumb`,
 * `beforeAddRecordingEvent`) instead of enumerating fields by hand — a new
 * span type or a future `data.foo.url` shape gets covered for free.
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

// gh-2046 S4 — the same thing, but for the URL-encoded boundary forms a
// value can arrive in once it has passed through one more layer of
// encoding (e.g. a redirect target embedded as a query-string value
// itself): `%3F` (`?`) or `%26` (`&`) directly followed by `lead%3D`
// (`lead=`), case-insensitive. The captured value runs up to (not
// including) the next encoded `%26`/`%23` separator, a literal
// `&`/`#`/whitespace/quote/angle-bracket, or the end of the string.
const LEAD_PARAM_ENCODED_RE = /((?:%3F|%26)lead%3D)((?:(?!%26|%23)[^&#\s"'<>])*)/gi;

/**
 * Redacts every `lead=<value>` occurrence in a string — plain or the
 * `%3Flead%3D` / `%26lead%3D` URL-encoded boundary forms — wherever it
 * appears (a full URL, a URL fragment embedded in prose, a span
 * description that quotes a URL, etc.). Strings with no match are
 * returned unchanged (same reference) so this is cheap to call on every
 * string in an event.
 */
export function redactLeadParam(value: string): string {
  if (typeof value !== "string") {
    return value;
  }
  // gh-2046 S3 — this fast-path guard exists purely to skip the regex
  // work on the (vast majority of) strings that cannot possibly match.
  // It MUST be at least as permissive as the regexes below, or it can
  // hide a real match behind a case-sensitive/encoding-sensitive skip —
  // which is exactly what happened with the original `indexOf("lead=")`
  // check on `?Lead=`/`?LEAD=` (S3) before this was lower-cased, and is
  // why it also checks the encoded `lead%3d` spelling (S4).
  const lower = value.toLowerCase();
  if (lower.indexOf("lead=") === -1 && lower.indexOf("lead%3d") === -1) {
    return value;
  }
  const afterPlain = value.replace(LEAD_PARAM_RE, `$1${LEAD_REDACTED_TOKEN}`);
  const afterEncoded = afterPlain.replace(LEAD_PARAM_ENCODED_RE, `$1${LEAD_REDACTED_TOKEN}`);
  return afterEncoded === value ? value : afterEncoded;
}

/**
 * Recursively walks any JSON-shaped value (Sentry events, transactions,
 * spans, breadcrumbs, and replay recording events are all plain
 * objects/arrays/strings/primitives by the time they reach these hooks)
 * and redacts `lead=` occurrences in every string it finds. Objects/arrays
 * are only cloned when something inside them actually changes, so
 * unrelated event fields keep their original identity.
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

/**
 * gh-2046 M1 — wraps `redactLeadDeep` so a thrown error inside it can
 * never cause a Sentry hook to drop the event/breadcrumb/recording-event
 * it was given. This matters most for `replayIntegration`'s
 * `beforeAddRecordingEvent`: returning `null`/`undefined` from that hook
 * drops the recording event outright (see @sentry/replay's
 * `BeforeAddRecordingEvent` type), so losing PII scrubbing on one
 * malformed payload is strictly preferable to silently corrupting or
 * truncating a replay. On error, the original (unredacted-for-this-call)
 * value is returned and the error is logged, never thrown or swallowed
 * silently.
 */
export function safeRedactLeadDeep<T>(value: T): T {
  try {
    return redactLeadDeep(value);
  } catch (err) {
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console -- deliberate: this is the only
      // signal we get that a Sentry hook's redaction path is broken.
      console.error("[gh-2046] redactLeadDeep threw; passing event through unredacted", err);
    }
    return value;
  }
}
