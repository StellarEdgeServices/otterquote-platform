// gh-1786 / D-320 — sender-side suppression tests.
// Run: deno test supabase/functions/send-homeowner-next-steps/optout-filter.test.ts
//
// #1786's closes-on: "a seeded suppressed recipient observed being SKIPPED while
// an unsuppressed one on the same run is sent — so a change that suppresses
// everybody, or nobody, cannot pass as a success." Both halves are asserted in
// the same test against the same input set.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { canSendWithOptOut, collectOptedOutClaimIds, isOptedOut } from "./optout-filter.ts";
import { OPTOUT_EVENT_TYPE } from "./optout-token.ts";

const SUPPRESSED = "aaaaaaaa-0000-0000-0000-000000000001";
const ALLOWED = "bbbbbbbb-0000-0000-0000-000000000002";

const rows = [
  { user_id: "u1", event_type: OPTOUT_EVENT_TYPE, metadata: { claim_id: SUPPRESSED }, created_at: "2026-09-07T00:00:00Z" },
  { user_id: "u2", event_type: "next_steps_nudge_sent", metadata: { claim_id: ALLOWED, nudge_stage: "2h" }, created_at: "2026-09-06T00:00:00Z" },
  { user_id: "u2", event_type: "claim_created", metadata: { claim_id: ALLOWED }, created_at: "2026-09-05T00:00:00Z" },
];

Deno.test("one suppressed and one allowed claim, same run: exactly one is skipped", () => {
  const optedOut = collectOptedOutClaimIds(rows);
  assertEquals(optedOut.size, 1);
  // The suppressed one is skipped...
  assertEquals(isOptedOut(optedOut, SUPPRESSED), true);
  // ...and the other one on the SAME run is not. This pair is what rules out
  // both "suppresses everybody" and "suppresses nobody".
  assertEquals(isOptedOut(optedOut, ALLOWED), false);
});

Deno.test("NEGATIVE CONTROL — with no opt-out row present, nothing is suppressed", () => {
  const optedOut = collectOptedOutClaimIds(rows.filter((r) => r.event_type !== OPTOUT_EVENT_TYPE));
  assertEquals(optedOut.size, 0);
  assertEquals(isOptedOut(optedOut, SUPPRESSED), false);
});

Deno.test("only the opt-out event type suppresses — a nudge stamp does not", () => {
  const optedOut = collectOptedOutClaimIds([
    { user_id: "u3", event_type: "next_steps_nudge_sent", metadata: { claim_id: SUPPRESSED }, created_at: "x" },
  ]);
  assertEquals(optedOut.size, 0);
});

Deno.test("an opt-out row with no claim_id is ignored, not treated as a global stop", () => {
  const optedOut = collectOptedOutClaimIds([
    { user_id: "u4", event_type: OPTOUT_EVENT_TYPE, metadata: {}, created_at: "x" },
    { user_id: "u5", event_type: OPTOUT_EVENT_TYPE, metadata: null, created_at: "x" },
    { user_id: "u6", event_type: OPTOUT_EVENT_TYPE, metadata: { claim_id: "" }, created_at: "x" },
  ]);
  assertEquals(optedOut.size, 0);
  assertEquals(isOptedOut(optedOut, ALLOWED), false);
});

Deno.test("duplicate opt-out rows collapse to one claim", () => {
  const optedOut = collectOptedOutClaimIds([rows[0], rows[0], rows[0]]);
  assertEquals(optedOut.size, 1);
});

Deno.test("the CAN-SPAM gate fails CLOSED without a signing secret", () => {
  assertEquals(canSendWithOptOut("a-secret"), true);
  // NEGATIVE CONTROL — every falsy/absent form refuses the run.
  assertEquals(canSendWithOptOut(""), false);
  assertEquals(canSendWithOptOut(null), false);
  assertEquals(canSendWithOptOut(undefined), false);
});
