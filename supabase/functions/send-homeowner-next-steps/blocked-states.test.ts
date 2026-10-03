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

// CTO REVIEW M1 (#2469): a failed blocked-states READ must fail closed -- the
// checklist stage sends nothing that tick -- instead of falling back to the
// default list (which would silently re-open any state added beyond FL/LA/TX).
// index.ts exports no handler, so this pins the wiring at source level.
Deno.test("blocked-states: index.ts checklist stage skips the tick on a blocked-states read error", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = src.indexOf("error: ccBlockedErr");
  if (start < 0) throw new Error("ccBlockedErr read not found in index.ts");
  const stage = src.slice(start);
  const gate = stage.indexOf("if (ccBlockedErr)");
  const firstElse = stage.indexOf("} else if (ccActivityErr)");
  if (gate < 0 || firstElse < 0 || gate > firstElse) {
    throw new Error("ccBlockedErr must head the checklist stage's error chain (before ccActivityErr), so a read error skips the send");
  }
  if (/blocked-states read failed, using default/.test(src)) {
    throw new Error("index.ts still falls back to the default list on a blocked-states read error");
  }
});
