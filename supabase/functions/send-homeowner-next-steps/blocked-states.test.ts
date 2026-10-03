// gh-1570 rail — the colocated blocked-states parser must agree with the one
// notify-admin-new-homeowner (gh-2421) uses; the EF deploy path cannot share
// code across directories, so this test is the single-source-of-truth guard.
// Run: deno test supabase/functions/send-homeowner-next-steps/blocked-states.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import * as local from "./blocked-states.ts";
import * as canonical from "../notify-admin-new-homeowner/notify-helpers.ts";

Deno.test("blocked-states: constants match notify-helpers", () => {
  assertEquals(local.BLOCKED_STATES_SETTING_KEY, canonical.BLOCKED_STATES_SETTING_KEY);
  assertEquals([...local.DEFAULT_BLOCKED_STATES], [...canonical.DEFAULT_BLOCKED_STATES]);
});

Deno.test("blocked-states: parseBlockedStates/normalizeState agree with notify-helpers on every input shape", () => {
  const inputs: unknown[] = [
    undefined, null, "FL", { a: 1 }, [1, 2], [], ["FL", "LA", "TX"], [" fl ", "tx"], ["NY", ""], 7,
  ];
  for (const i of inputs) {
    assertEquals(local.parseBlockedStates(i), canonical.parseBlockedStates(i), JSON.stringify(i));
    assertEquals(local.normalizeState(i), canonical.normalizeState(i), JSON.stringify(i));
  }
});
