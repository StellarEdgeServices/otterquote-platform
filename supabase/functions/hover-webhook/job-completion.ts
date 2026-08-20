/**
 * hover-webhook — job-state-changed-v2 completion detection (pure, unit-testable).
 *
 * Extracted from index.ts so the state → status mapping and completion check
 * can be unit-tested without booting the Deno HTTP server (top-level serve()).
 * No side effects, no imports — same-folder sibling so the standalone
 * Supabase CLI bundles it into the function's eszip (a within-folder
 * relative import, matching the docusign-webhook/payload-parser.ts pattern).
 *
 * Issue #430: Hover deprecated the legacy job-state-changed webhook event
 * (state value "complete") in favor of job-state-changed-v2 (state value
 * "completed"). This module is now the ONLY place that decides whether an
 * incoming event represents job completion — the deprecated shape's
 * "complete" value is no longer recognized as completion.
 */

/** Maps a job-state-changed-v2 `state` value to the internal hover_orders.status. */
export const HOVER_ORDER_STATUS_MAP: Record<string, string> = {
  processing: "processing",
  completed: "complete", // job-state-changed-v2 semantics (#430)
  failed: "failed",
  cancelled: "cancelled",
};

export interface JobStateResult {
  /** Internal hover_orders.status value to persist (falls back to previousStatus if unrecognized). */
  newStatus: string;
  /** True only when the job-state-changed-v2 event reports state === "completed". */
  isCompleted: boolean;
}

/**
 * Resolve an incoming job-state-changed-v2 `state` value into the internal
 * hover_orders.status and a completion flag. The deprecated shape's
 * "complete" value is intentionally NOT mapped or treated as completion —
 * it falls through to `previousStatus` like any other unrecognized value.
 */
export function resolveJobState(
  state: unknown,
  previousStatus: string,
): JobStateResult {
  const key = typeof state === "string" ? state : "";
  return {
    newStatus: HOVER_ORDER_STATUS_MAP[key] || previousStatus,
    isCompleted: key === "completed",
  };
}
