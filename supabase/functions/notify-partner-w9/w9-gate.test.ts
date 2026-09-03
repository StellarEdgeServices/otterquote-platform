// Deno unit tests for notify-partner-w9's D-319 flag logic (gh-1509 half A).
// Run: deno test supabase/functions/notify-partner-w9/w9-gate.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  readW9GateFlag,
  type SettingsFetcher,
  shouldSkipW9Notification,
  skipResponseBody,
  W9_GATE_FLAG_KEY,
} from "./w9-gate.ts";

function fakeFetcher(
  row: { value: unknown } | null,
  error: { message: string } | null = null,
): SettingsFetcher {
  return async () => ({ data: row, error });
}

Deno.test("OFF (default): no row -> flag false -> send not skipped", async () => {
  const flag = await readW9GateFlag(fakeFetcher(null));
  assertEquals(flag, false);
  assertEquals(shouldSkipW9Notification(flag), false);
});

Deno.test("OFF: row present with value=false -> send not skipped", async () => {
  const flag = await readW9GateFlag(fakeFetcher({ value: false }));
  assertEquals(shouldSkipW9Notification(flag), false);
});

Deno.test("ON: row present with value=true -> send skipped", async () => {
  const flag = await readW9GateFlag(fakeFetcher({ value: true }));
  assertEquals(flag, true);
  assertEquals(shouldSkipW9Notification(flag), true);
});

Deno.test("read error -> fail-safe false -> send not skipped, error logged", async () => {
  let logged = "";
  const flag = await readW9GateFlag(
    fakeFetcher(null, { message: "db down" }),
    (msg) => { logged = msg; },
  );
  assertEquals(flag, false);
  assertEquals(shouldSkipW9Notification(flag), false);
  assertEquals(logged.includes("db down"), true);
  assertEquals(logged.includes(W9_GATE_FLAG_KEY), true);
});

Deno.test("skipResponseBody shape", () => {
  const body = skipResponseBody("agent-123");
  assertEquals(body.success, true);
  assertEquals(body.skipped, true);
  assertEquals(body.agent_id, "agent-123");
});
