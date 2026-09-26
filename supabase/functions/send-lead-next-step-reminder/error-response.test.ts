// gh-2213 (js/stack-trace-exposure, CodeQL alert #57) — working test,
// written first (#2121 rule 2 / this repo's fail-first convention; see
// mint-test-session/gate.test.ts's own unexpectedErrorResponse tests for
// the pattern this copies). Two sinks existed in index.ts before this fix:
// the outer catch (`JSON.stringify({ error: String(err) })`) and the
// candidate-query failure branch (`JSON.stringify({ error: candErr.message
// })`, TRIAGE follow-up, Marty CTO RUN 41, #2213 comment 5848074328). Both
// negative controls below are `ignore: true` so they document (and, run
// manually with `ignore` deleted/flipped, PROVE) the old vulnerable shapes
// fail these assertions, without leaving an always-red test in the default
// `deno test` sweep — see PR #2215 for the captured red run pasted as
// evidence per this repo's R-147 convention.
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { internalErrorResponse, unexpectedErrorResponse } from "./error-response.ts";

const FUNCTION_NAME = "send-lead-next-step-reminder";

Deno.test({
  name: "NEGATIVE CONTROL (ignored): pre-fix outer-catch shape leaks the message",
  ignore: true,
  fn() {
    const secretDetail = new Error("Supabase credentials not configured at /internal/path.ts:42");
    // The exact old (pre-fix) construction from index.ts's outer catch.
    const oldResult = { status: 500, body: { error: String(secretDetail) } };
    assertEquals(
      JSON.stringify(oldResult.body).includes("Supabase credentials not configured"),
      false,
    );
  },
});

Deno.test({
  name: "NEGATIVE CONTROL (ignored): pre-fix candErr shape leaks the message",
  ignore: true,
  fn() {
    const candErr = { message: "relation \"leads\" does not exist on schema internal_v3" };
    // The exact old (pre-fix) construction from index.ts's candidate-query
    // failure branch.
    const oldResult = { status: 500, body: { error: candErr.message } };
    assertEquals(
      JSON.stringify(oldResult.body).includes("internal_v3"),
      false,
    );
  },
});

Deno.test("unexpectedErrorResponse: generic body, real detail still logged (Error input)", () => {
  const loggedCalls: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedCalls.push(args);
  };

  try {
    const secretDetail = new Error("Supabase credentials not configured");
    secretDetail.stack =
      "Error: Supabase credentials not configured\n    at very/internal/path.ts:42:7";
    const result = unexpectedErrorResponse(FUNCTION_NAME, secretDetail);

    assertEquals(result.status, 500);
    assertEquals(result.body, { error: "Internal server error" });

    const serializedBody = JSON.stringify(result.body);
    assertEquals(serializedBody.includes("Supabase credentials"), false);
    assertEquals(serializedBody.includes("very/internal/path.ts"), false);

    assertEquals(loggedCalls.length, 1);
    const loggedText = Deno.inspect(loggedCalls[0]);
    assertStringIncludes(loggedText, "Supabase credentials not configured");
  } finally {
    console.error = originalConsoleError;
  }
});

Deno.test("unexpectedErrorResponse: non-Error throw still yields the generic body", () => {
  const originalConsoleError = console.error;
  let logged = "";
  console.error = (...args: unknown[]) => {
    logged = Deno.inspect(args);
  };

  try {
    const result = unexpectedErrorResponse(FUNCTION_NAME, "raw string throw: /etc/secrets.env");
    assertEquals(result.status, 500);
    assertEquals(result.body, { error: "Internal server error" });
    assertEquals(JSON.stringify(result.body).includes("/etc/secrets.env"), false);
    assertStringIncludes(logged, "/etc/secrets.env");
  } finally {
    console.error = originalConsoleError;
  }
});

// gh-2213 follow-up (Marty, CTO RUN 41, #2213 comment 5848074328): the
// candidate-query failure branch in index.ts calls internalErrorResponse()
// after its OWN console.error(...candErr.message) line, rather than
// unexpectedErrorResponse — so this helper takes no `err` argument and
// must never be able to carry a Postgrest error's message into the body,
// no matter what that message says.
Deno.test("internalErrorResponse: fixed generic body regardless of caller-side detail", () => {
  const candErrLike = { message: "relation \"leads\" does not exist on schema internal_v3" };
  const result = internalErrorResponse();

  assertEquals(result.status, 500);
  assertEquals(result.body, { error: "Internal server error" });
  assertEquals(JSON.stringify(result.body).includes(candErrLike.message), false);
  assertEquals(JSON.stringify(result.body).includes("internal_v3"), false);
});
