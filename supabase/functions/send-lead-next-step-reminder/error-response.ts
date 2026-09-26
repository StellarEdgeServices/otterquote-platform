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
export interface UnexpectedErrorResult {
  status: number;
  body: { error: string };
}

export function unexpectedErrorResponse(
  functionName: string,
  err: unknown,
): UnexpectedErrorResult {
  console.error(`[${functionName}] unexpected failure: ${String(err)}`);
  return { status: 500, body: { error: "Internal server error" } };
}
