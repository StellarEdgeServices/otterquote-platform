// gh-2213 (js/stack-trace-exposure, CodeQL alert #57) — working test,
// written first (#2121 rule 2 / this repo's fail-first convention; see
// mint-test-session/gate.test.ts's own unexpectedErrorResponse tests for
// the pattern this copies). Before the fix, index.ts's catch block built
// its 500 response from `JSON.stringify({ error: String(err) })` directly
// — no such body-shape guarantee existed. Run against that old inline
// construction (`{ status: 500, body: { error: String(err) } }` in place
// of calling unexpectedErrorResponse), the assertions below fail because
// the caught error's message leaks straight into the response body — see
// the PR/issue evidence for the captured red run. Not kept as a permanent
// negative-control test here since an always-failing test would poison
// every future CI run of this suite; the fail-first proof lives in the
// pasted command output instead (this repo's R-147 evidence convention).
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { unexpectedErrorResponse } from "./error-response.ts";

const FUNCTION_NAME = "send-lead-next-step-reminder";

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
