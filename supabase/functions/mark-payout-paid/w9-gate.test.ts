// Deno unit tests for mark-payout-paid's D-319 W-9 gate (gh-1509 slot a).
// Run: deno test supabase/functions/mark-payout-paid/w9-gate.test.ts
//
// Also asserts index.ts actually wires the flag in (source-level check), so a
// regression that drops readW9GateFlag/isW9GateHeld from index.ts fails here.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  isW9GateHeld,
  readW9GateFlag,
  type SettingsFetcher,
  w9GateHeldReason,
  W9_GATE_FLAG_KEY,
} from "./w9-gate.ts";

const fakeFetcher = (
  row: { value: unknown } | null,
  error: { message: string } | null = null,
): SettingsFetcher => async () => ({ data: row, error });

const noW9 = { payments_blocked: false, w9_verified_at: null };

Deno.test("flag ON + no W-9 -> not held", () => {
  assertEquals(isW9GateHeld(noW9, true), false);
});
Deno.test("flag OFF + no W-9 -> held (current behavior)", () => {
  assertEquals(isW9GateHeld(noW9, false), true);
  assertEquals(w9GateHeldReason(noW9), "Held — partner W-9 not on file");
});
Deno.test("flag ON does not lift payments_blocked", () => {
  assertEquals(isW9GateHeld({ payments_blocked: true, w9_verified_at: null }, true), true);
  assertEquals(isW9GateHeld({ payments_blocked: null, w9_verified_at: "x" }, true), true);
});
Deno.test("flag OFF + verified W-9 + unblocked -> not held", () => {
  assertEquals(isW9GateHeld({ payments_blocked: false, w9_verified_at: "2026-01-01" }, false), false);
});
Deno.test("readW9GateFlag: true row -> true; false/missing row -> false", async () => {
  assertEquals(W9_GATE_FLAG_KEY, "w9_gate_retired");
  assertEquals(await readW9GateFlag(fakeFetcher({ value: true })), true);
  assertEquals(await readW9GateFlag(fakeFetcher({ value: false })), false);
  assertEquals(await readW9GateFlag(fakeFetcher(null)), false);
});
Deno.test("flag read error -> gate enforced (held)", async () => {
  const flag = await readW9GateFlag(fakeFetcher(null, { message: "boom" }));
  assertEquals(flag, false);
  assertEquals(isW9GateHeld(noW9, flag), true);
});
Deno.test("index.ts wires the flag into the hold decision", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(src.includes("readW9GateFlag("), true);
  assertEquals(src.includes("isW9GateHeld(agent, w9GateRetired)"), true);
});
