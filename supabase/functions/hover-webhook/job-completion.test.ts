// Deno unit tests for the hover-webhook job-state-changed-v2 completion mapping.
// Run: deno test supabase/functions/hover-webhook/job-completion.test.ts
//
// Issue #430: Hover is deprecating job-state-changed (state "complete") in
// favor of job-state-changed-v2 (state "completed"). These tests assert the
// v2 shape drives completion detection and that the deprecated value no
// longer does.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { resolveJobState } from "./job-completion.ts";

Deno.test("job-state-changed-v2: state 'completed' is detected as job completion", () => {
  const result = resolveJobState("completed", "processing");
  assertEquals(result.isCompleted, true);
  assertEquals(result.newStatus, "complete");
});

Deno.test("deprecated shape: state 'complete' is NOT treated as completion", () => {
  const result = resolveJobState("complete", "processing");
  assertEquals(result.isCompleted, false);
  // Falls through to previousStatus — "complete" is not a recognized v2 key.
  assertEquals(result.newStatus, "processing");
});

Deno.test("state 'processing' maps through unchanged, not completed", () => {
  const result = resolveJobState("processing", "pending");
  assertEquals(result.isCompleted, false);
  assertEquals(result.newStatus, "processing");
});

Deno.test("state 'failed' maps through, not completed", () => {
  const result = resolveJobState("failed", "processing");
  assertEquals(result.isCompleted, false);
  assertEquals(result.newStatus, "failed");
});

Deno.test("state 'cancelled' maps through, not completed", () => {
  const result = resolveJobState("cancelled", "processing");
  assertEquals(result.isCompleted, false);
  assertEquals(result.newStatus, "cancelled");
});

Deno.test("unrecognized/missing state falls back to previous status", () => {
  const result = resolveJobState(undefined, "processing");
  assertEquals(result.isCompleted, false);
  assertEquals(result.newStatus, "processing");
});

Deno.test("full job-state-changed-v2 payload shape end-to-end via resolveJobState", () => {
  // Representative job-state-changed-v2 payload per issue #430 AC.
  const payload = {
    event: "job-state-changed-v2",
    job_id: 98765,
    state: "completed",
  };
  const result = resolveJobState(payload.state, "processing");
  assertEquals(result.isCompleted, true);
  assertEquals(result.newStatus, "complete");
});
