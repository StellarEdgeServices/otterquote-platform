// Negative-control fixture (gh-1738) -- deliberately WRONG, on purpose.
//
// This file is NEVER included in the main test step of
// .github/workflows/netlify-edge-functions.yml. It exists solely so that
// workflow's separate "negative control" step can prove the test command
// itself actually fails when handed a failing case, rather than the whole
// job being green by default no matter what runs. Per gh-1738's own
// thesis: "a gate is not trusted until it has been observed rejecting the
// thing it exists to reject" -- this is that observation, applied to this
// gate rather than assumed of it.
//
// If this file is ever changed to pass, or the CI step stops asserting
// this command's exit code is non-zero, the gate has gone blind exactly
// like the four original gh-1738 instances did.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

// A stub "handler" shaped like a real edge function, that always throws --
// the "stub that always throws" shape named in the work order.
async function alwaysThrowingHandler(): Promise<Response> {
  throw new Error("negative-control: this handler always throws by design");
}

Deno.test("negative control: asserts a value that can never match (must FAIL every run)", () => {
  const actual = 1 + 1;
  // Deliberately wrong: 1 + 1 is 2, never 3. If this ever reads `ok`, the
  // test command is not actually being executed, or assertEquals has
  // stopped asserting.
  assertEquals(actual, 3, "deliberately wrong assertion -- must fail every run");
});

Deno.test("negative control: a handler that always throws must be observed throwing, unhandled", async () => {
  // Intentionally NOT wrapped in try/catch. If alwaysThrowingHandler() ever
  // resolves instead of rejecting, this awaits a value and the test framework
  // reports a pass -- which would be the fixture silently going stale. As
  // written today it always rejects, so this test always fails.
  await alwaysThrowingHandler();
});
