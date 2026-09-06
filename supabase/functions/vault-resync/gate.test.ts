// Deno unit tests for vault-resync's caller gate + write planning (gh-1531).
// Run: deno test supabase/functions/vault-resync/gate.test.ts
//
// No live Supabase client, no network, no listener — index.ts's serve() is
// never imported here (same pattern as mint-test-session/gate.test.ts).

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  authorizeCaller,
  describe,
  parseBody,
  planResync,
  PRIMARY_ADMIN_EMAIL,
  RESYNC_TARGETS,
} from "./gate.ts";

const fakeEnv = (vars: Record<string, string | undefined>) => ({
  get: (n: string) => vars[n],
});
const SRK = "sb_secret_FAKE_service_role_key_0123456789";
const CS = "FAKE_cron_secret_value_abcdefghijklmnop";

// ── Caller gate ───────────────────────────────────────────────────────────

Deno.test("refuses a non-admin caller with 403", () => {
  const r = authorizeCaller("someone-else@example.com");
  assertEquals(r, { ok: false, status: 403, error: "Unauthorized" });
});

Deno.test("refuses the secondary admin address (single-admin list, gh-1534) with 403", () => {
  const r = authorizeCaller("dustin@otterquote.com");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 403);
});

Deno.test("refuses a case-variant of the admin email (case-sensitive exact match)", () => {
  const r = authorizeCaller(PRIMARY_ADMIN_EMAIL.toUpperCase());
  assertEquals(r.ok, false);
});

Deno.test("refuses a missing / unverified caller with 401", () => {
  for (const v of [null, undefined, ""]) {
    const r = authorizeCaller(v);
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.status, 401);
  }
});

Deno.test("accepts the primary admin", () => {
  assertEquals(authorizeCaller(PRIMARY_ADMIN_EMAIL), { ok: true });
});

// ── Planning ──────────────────────────────────────────────────────────────

Deno.test("plans both Vault names from env by default", () => {
  const plan = planResync(fakeEnv({ SUPABASE_SERVICE_ROLE_KEY: SRK, CRON_SECRET: CS }));
  assertEquals(plan.items.map((i) => i.name).sort(), Object.keys(RESYNC_TARGETS).sort());
  assertEquals(plan.missing, []);
  assertEquals(plan.rejected, []);
  assertEquals(plan.items.find((i) => i.name === "cron_secret")?.value, CS);
});

Deno.test("an unset env var is reported by NAME and skipped, never written as empty", () => {
  const plan = planResync(fakeEnv({ SUPABASE_SERVICE_ROLE_KEY: SRK }));
  assertEquals(plan.items.map((i) => i.name), ["cron_service_role_key"]);
  assertEquals(plan.missing, ["CRON_SECRET"]);
});

Deno.test("a short/empty value counts as missing", () => {
  const plan = planResync(fakeEnv({ SUPABASE_SERVICE_ROLE_KEY: SRK, CRON_SECRET: "short" }));
  assertEquals(plan.missing, ["CRON_SECRET"]);
  assertEquals(plan.items.length, 1);
});

Deno.test("a requested name outside the allow-list is rejected, not silently ignored", () => {
  const plan = planResync(fakeEnv({ SUPABASE_SERVICE_ROLE_KEY: SRK, CRON_SECRET: CS }), [
    "cron_secret",
    "stripe_secret_key",
  ]);
  assertEquals(plan.items.map((i) => i.name), ["cron_secret"]);
  assertEquals(plan.rejected, ["stripe_secret_key"]);
});

Deno.test("describe() never carries the value — only len and a 4-char prefix", () => {
  const item = { name: "cron_secret", envName: "CRON_SECRET", value: CS };
  const row = describe(item, "updated");
  assertEquals(row, { name: "cron_secret", action: "updated", len: CS.length, prefix: CS.slice(0, 4) });
  assertEquals(JSON.stringify(row).includes(CS), false);
  assertNotEquals(row.prefix, CS);
});

Deno.test("parseBody defaults and dry_run", () => {
  assertEquals(parseBody(undefined), { names: null, dryRun: false });
  assertEquals(parseBody({ dry_run: true, names: ["cron_secret", 42] }), {
    names: ["cron_secret"],
    dryRun: true,
  });
  assertEquals(parseBody({ dry_run: "yes" }).dryRun, false);
});
