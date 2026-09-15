'use client';

/**
 * Shared GA4 emit call site — gh-1940, rebuilt on gh-1948 / gh-1960.
 *
 * get-started/page.tsx keeps its OWN local, more tightly-typed track() (added
 * in gh-1948) for the signup form's own events (form_start,
 * form_step_complete, form_abandon, sign_up, homeowner_signup) — that one
 * is NOT duplicated here. This file exists for the funnel steps AFTER
 * signup (claim_started through contract_signed), which had no shared call
 * site before this PR, plus the OAuth-callback sign_up guard in
 * app/auth-callback/page.tsx.
 *
 * `transport_type: 'beacon'` was REMOVED from this design (present in
 * PR #1960, which this PR supersedes) per the independent review at
 * cto31-pr1960-review-20260915.md (REVIEW: FAIL, findings D-B1/D-M1):
 * passing `transport_type` as a gtag EVENT PARAMETER does not change
 * delivery transport. gtag.js already ships every hit via
 * `navigator.sendBeacon` / `fetch(keepalive:true)` regardless of this
 * option — the value is instead forwarded to GA4 as a junk custom event
 * parameter (`ep.transport_type`), consuming one of the 25-per-event
 * parameter slots for nothing. Deleting it costs nothing; delivery was
 * already correct without it. If a real unload-safety concern ever comes
 * up at a specific call site, the correct mechanism is
 * `gtag('config', GA_ID, { transport_type: 'beacon' })` (a CONFIG-level
 * call, not an event parameter) or an `event_callback` + timeout guard —
 * neither is needed by any event this file currently wires.
 *
 * Safe by construction, matching get-started's local track():
 *   - Never throws — every failure mode (gtag absent, window absent, a
 *     malformed param) is swallowed. Analytics must never break a user
 *     action.
 *   - Never blocks — synchronous, fire-and-forget.
 *   - Never queues — if `window.gtag` is not present right now, the event
 *     is dropped, not buffered (GA4Gate is fail-closed by design).
 *   - Never loads gtag itself — app/components/GA4Gate.tsx remains the
 *     only place the GA4 library is requested.
 *   - No PII — every param below is a closed union, an id, or a count.
 *     Nothing here ever carries a field VALUE typed as a bare `string`.
 */

type TrackEventParams = {
  /** trade-selector — first claim row for this user only (see call site). */
  claim_started: { funding_type: string | null; policy_type: string | null };
  /** repair-intake — once per confirmed photo upload. `tier` is a category label, not file content. */
  document_uploaded: { tier: string };
  /** help-estimate / help-materials / help-measurements — fires only on confirmed success. */
  help_tool_used: { tool: 'help_estimate' | 'help_materials' | 'help_measurements'; method?: string };
  /** bids page — first render with >=1 bid loaded. */
  bids_viewed: { bid_count: number };
  /** bids/actions.ts — after every award write succeeds. */
  bid_accepted: { claim_id: string };
  /** contract-signing — after the sign-complete write settles. */
  contract_signed: { claim_id: string | null };
  /**
   * auth-callback landing — gh-1940 sign_up reliability fix. Fired ONLY for
   * a newly-created user, ONLY once, at the point session + role are known
   * (not pre-redirect). method is deliberately narrowed to 'google': the
   * password path's sign_up already lives in get-started/page.tsx and is
   * unchanged by this PR.
   */
  sign_up: { method: 'google' };
};

function getGtag(): ((...args: unknown[]) => void) | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { gtag?: (...args: unknown[]) => void };
  return typeof w.gtag === 'function' ? w.gtag : undefined;
}

export function track<E extends keyof TrackEventParams>(event: E, params: TrackEventParams[E]): void {
  try {
    const gtag = getGtag();
    if (!gtag) return; // GA4Gate has not loaded (blocked host, ad blocker, SSR) — no-op, no queue.
    gtag('event', event, { ...params });
  } catch {
    // Never throw — an analytics failure must never break a user-facing action.
  }
}
