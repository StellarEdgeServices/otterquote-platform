// Deno unit tests for process-payout-reminders' D-319 flag logic (gh-1509 half A).
// Run: deno test supabase/functions/process-payout-reminders/w9-gate.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  readW9GateFlag,
  type SettingsFetcher,
  shouldSkipW9ReminderJob,
  W9_GATE_FLAG_KEY,
} from "./w9-gate.ts";

function fakeFetcher(
  row: { value: unknown } | null,
  error: { message: string } | null = null,
): SettingsFetcher {
  return async () => ({ data: row, error });
}

Deno.test("OFF (default): no row -> flag false -> JOB 3 runs", async () => {
  const flag = await readW9GateFlag(fakeFetcher(null));
  assertEquals(flag, false);
  assertEquals(shouldSkipW9ReminderJob(flag), false);
});

Deno.test("OFF: row present with value=false -> JOB 3 runs", async () => {
  const flag = await readW9GateFlag(fakeFetcher({ value: false }));
  assertEquals(shouldSkipW9ReminderJob(flag), false);
});

Deno.test("ON: row present with value=true -> JOB 3 skipped", async () => {
  const flag = await readW9GateFlag(fakeFetcher({ value: true }));
  assertEquals(flag, true);
  assertEquals(shouldSkipW9ReminderJob(flag), true);
});

Deno.test("read error -> fail-safe false -> JOB 3 runs, error logged", async () => {
  let logged = "";
  const flag = await readW9GateFlag(
    fakeFetcher(null, { message: "timeout" }),
    (msg) => { logged = msg; },
  );
  assertEquals(flag, false);
  assertEquals(shouldSkipW9ReminderJob(flag), false);
  assertEquals(logged.includes("timeout"), true);
});
