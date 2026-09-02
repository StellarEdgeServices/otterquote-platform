// Deno unit tests for approve-payout's D-319 W-9 gate logic (gh-1509 half A).
// Run: deno test supabase/functions/approve-payout/w9-gate.test.ts
//
// Exercises isW9GateHeld / w9GateHeldReason / readW9GateFlag against plain
// object literals and a fake SettingsFetcher — no live Supabase client, no
// network access (same source-split pattern as mint-test-session/gate.test.ts).

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  isW9GateHeld,
  readW9GateFlag,
  type SettingsFetcher,
  w9GateHeldReason,
  W9_GATE_FLAG_KEY,
} from "./w9-gate.ts";

function fakeFetcher(
  row: { value: unknown } | null,
  error: { message: string } | null = null,
): SettingsFetcher {
  return async () => ({ data: row, error });
}

// ── Flag OFF (default) — byte-identical to the pre-D-319 inline guard ──────

Deno.test("OFF: held when payments_blocked is true, regardless of w9_verified_at", () => {
  assertEquals(
    isW9GateHeld({ payments_blocked: true, w9_verified_at: "2026-01-01T00:00:00Z" }, false),
    true,
  );
});

Deno.test("OFF: held when w9_verified_at is null even if payments_blocked is false", () => {
  assertEquals(
    isW9GateHeld({ payments_blocked: false, w9_verified_at: null }, false),
    true,
  );
});

Deno.test("OFF: not held when payments_blocked is false and w9_verified_at is set", () => {
  assertEquals(
    isW9GateHeld({ payments_blocked: false, w9_verified_at: "2026-01-01T00:00:00Z" }, false),
    false,
  );
});

Deno.test("OFF: payments_blocked null is treated as blocked (matches !== false)", () => {
  assertEquals(
    isW9GateHeld({ payments_blocked: null, w9_verified_at: "2026-01-01T00:00:00Z" }, false),
    true,
  );
});

// ── Flag ON — only the w9_verified_at condition retires ────────────────────

Deno.test("ON: approves a w9_verified_at-null row when payments_blocked is false", () => {
  assertEquals(
    isW9GateHeld({ payments_blocked: false, w9_verified_at: null }, true),
    false,
  );
});

Deno.test("ON: payments_blocked=true still HOLDS — flag does not touch that condition", () => {
  assertEquals(
    isW9GateHeld({ payments_blocked: true, w9_verified_at: null }, true),
    true,
  );
});

Deno.test("ON: payments_blocked=null still HOLDS", () => {
  assertEquals(
    isW9GateHeld({ payments_blocked: null, w9_verified_at: null }, true),
    true,
  );
});

// ── Reason text ──────────────────────────────────────────────────────────

Deno.test("reason: payments_blocked branch wins when both conditions would hold", () => {
  assertEquals(
    w9GateHeldReason({ payments_blocked: true, w9_verified_at: null }),
    "Held — partner payments are blocked (W-9 not on file)",
  );
});

Deno.test("reason: W-9-only branch when payments_blocked is false", () => {
  assertEquals(
    w9GateHeldReason({ payments_blocked: false, w9_verified_at: null }),
    "Held — partner W-9 not on file",
  );
});

// ── readW9GateFlag ───────────────────────────────────────────────────────

Deno.test("readW9GateFlag: no row -> false (fail-safe default, gate enforced)", async () => {
  const result = await readW9GateFlag(fakeFetcher(null));
  assertEquals(result, false);
});

Deno.test("readW9GateFlag: row present with value=true -> true", async () => {
  const result = await readW9GateFlag(fakeFetcher({ value: true }));
  assertEquals(result, true);
});

Deno.test("readW9GateFlag: row present with value=false -> false", async () => {
  const result = await readW9GateFlag(fakeFetcher({ value: false }));
  assertEquals(result, false);
});

Deno.test("readW9GateFlag: non-boolean value (e.g. stray string) -> false", async () => {
  const result = await readW9GateFlag(fakeFetcher({ value: "true" }));
  assertEquals(result, false);
});

Deno.test("readW9GateFlag: read error -> false (fail-safe), logs the error", async () => {
  let logged = "";
  const result = await readW9GateFlag(
    fakeFetcher(null, { message: "boom" }),
    (msg) => { logged = msg; },
  );
  assertEquals(result, false);
  assertEquals(logged.includes("boom"), true);
  assertEquals(logged.includes(W9_GATE_FLAG_KEY), true);
});
