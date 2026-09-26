// gh-2213 (js/stack-trace-exposure, CodeQL alert #57): index.ts's outer
// catch previously serialized `String(err)` straight into the HTTP
// response body, which for an Error includes its message (and, depending
// on the caller, can carry internal detail an attacker could use to
// fingerprint the implementation — CWE-209/CWE-497). Split out here, same
// source-split pattern this repo already uses for testability (see
// mint-test-session/gate.ts's own `unexpectedErrorResponse`, and
// notify-admin-new-partner/index.ts's dependency-injection convention).
//
// Fix: the response body is always the fixed generic string below; the
// real error (message + whatever `String(err)` produces for non-Error
// throws) still reaches console.error, matching this repo's established
// "Internal server error" client-facing pattern (fix(gh-1381) Batch A,
// send-incomplete-onboarding-reminders/index.ts and 12 other EFs).
//
// TRIAGE follow-up (Marty, CTO RUN 41, issue #2213 comment 5848074328):
// the candidate-query failure branch had the SAME sink one path over —
// `JSON.stringify({ error: candErr.message })` — which this file's own
// existing `console.error(...candErr.message)` call already logs, so that
// call site keeps its own logging and only needs the generic body below
// (`internalErrorResponse`), not a second console.error via
// `unexpectedErrorResponse`.
export interface UnexpectedErrorResult {
  status: number;
  body: { error: string };
}

const INTERNAL_SERVER_ERROR_BODY = { error: "Internal server error" } as const;

export function unexpectedErrorResponse(
  functionName: string,
  err: unknown,
): UnexpectedErrorResult {
  console.error(`[${functionName}] unexpected failure: ${String(err)}`);
  return { status: 500, body: INTERNAL_SERVER_ERROR_BODY };
}

// For sinks that already log their own detail (e.g. a Postgrest error's
// `.message`) immediately before returning — same generic body and status,
// no second console.error here so the caller's own, more specific log line
// isn't duplicated or shadowed.
export function internalErrorResponse(): UnexpectedErrorResult {
  return { status: 500, body: INTERNAL_SERVER_ERROR_BODY };
}
