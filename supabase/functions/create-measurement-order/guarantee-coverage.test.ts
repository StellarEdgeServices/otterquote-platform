// gh-3471 (#3427 D6) -- unit tests for guarantee-coverage.ts (parse rules, decision order, alert row). The handler path is in guarantee-coverage-handler.test.ts.
// Run: deno test --allow-read=supabase/functions supabase/functions/create-measurement-order/guarantee-coverage.test.ts
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildCoverageAlertRow,
  coverageNeedsAlert,
  decideGuaranteeCoverage,
  EXCLUDED_STATES_SETTING_KEY,
  GUARANTEE_COVERAGE_ALERT_TYPE,
  normalizePropertyState,
  parseExcludedStates,
  raiseCoverageAlert,
} from "./guarantee-coverage.ts";

Deno.test("constants: the config key and alert type", () => {
  assertEquals(EXCLUDED_STATES_SETTING_KEY, "guarantee_excluded_states");
  assertEquals(GUARANTEE_COVERAGE_ALERT_TYPE, "guarantee_coverage_unknown");
});

Deno.test("parseExcludedStates: no row = unconfigured; [] = configured & empty; codes are space-trimmed, upper-cased, de-duplicated, sorted", () => {
  assertEquals(parseExcludedStates(null), { kind: "unconfigured" });
  assertEquals(parseExcludedStates(undefined), { kind: "unconfigured" });
  assertEquals(parseExcludedStates({ value: [] }), { kind: "configured", states: [] });
  assertEquals(parseExcludedStates({ value: ["ny", " CA ", "NY"] }), { kind: "configured", states: ["CA", "NY"] });
});

Deno.test("parseExcludedStates: malformed as a WHOLE (never drop one bad element and cover the rest)", () => {
  for (const v of [null, "NY", 1, true, { NY: 1 }, ["NY", "Calif"], ["NY", 1], ["NY", null], ["N"], ["\tNY"], ["NYC"]]) {
    assertEquals(parseExcludedStates({ value: v }), { kind: "malformed" }, JSON.stringify(v));
  }
  assertEquals(parseExcludedStates({}), { kind: "malformed" }, "a row with no value");
});

Deno.test("normalizePropertyState: trim + upper; anything that is not two letters A-Z is null (unknown)", () => {
  assertEquals(normalizePropertyState(" in "), "IN");
  assertEquals(normalizePropertyState("Tx"), "TX");
  for (const v of [null, undefined, "", "  ", "Indiana", "I", "1N", 42]) assertEquals(normalizePropertyState(v), null, String(v));
});

const deps = (over: Partial<Parameters<typeof decideGuaranteeCoverage>[0]> = {}) => {
  const logs: string[] = [];
  return {
    logs,
    d: {
      claimReadOk: true,
      propertyState: "IN" as unknown,
      readExcludedSetting: () => Promise.resolve({ value: ["NY"] } as { value?: unknown } | null),
      log: (m: string) => { logs.push(m); },
      ...over,
    },
  };
};

Deno.test("decideGuaranteeCoverage: covered / excluded / unknown, with the reason", async () => {
  assertEquals(await decideGuaranteeCoverage(deps().d), { covered: true, reason: "covered", state: "IN" });
  assertEquals(await decideGuaranteeCoverage(deps({ propertyState: " ny" }).d), { covered: false, reason: "excluded_state", state: "NY" });
  assertEquals((await decideGuaranteeCoverage(deps({ propertyState: "" }).d)).reason, "no_property_state");
  assertEquals((await decideGuaranteeCoverage(deps({ claimReadOk: false }).d)).reason, "claim_read_failed");
  assertEquals((await decideGuaranteeCoverage(deps({ readExcludedSetting: () => Promise.resolve(null) }).d)).reason, "list_not_configured");
  assertEquals((await decideGuaranteeCoverage(deps({ readExcludedSetting: () => Promise.resolve({ value: "NY" }) }).d)).reason, "list_malformed");
  const f = deps({ readExcludedSetting: () => Promise.reject(new Error("x")) });
  assertEquals(await decideGuaranteeCoverage(f.d), { covered: null, reason: "list_read_failed", state: null });
  assertEquals(f.logs.length, 1);
});

Deno.test("decideGuaranteeCoverage: an unset list wins over a missing state or a failed claim read (one quiet reason, no alert)", async () => {
  const unset = () => Promise.resolve(null);
  for (const over of [{ propertyState: null }, { claimReadOk: false }]) {
    const r = await decideGuaranteeCoverage(deps({ ...over, readExcludedSetting: unset }).d);
    assertEquals(r.reason, "list_not_configured");
    assertEquals(coverageNeedsAlert(r), false);
  }
});

Deno.test("decideGuaranteeCoverage never throws, even if the reader throws synchronously or the logger throws", async () => {
  const r = await decideGuaranteeCoverage({
    claimReadOk: true,
    propertyState: "IN",
    readExcludedSetting: () => { throw new Error("sync"); },
    log: () => { throw new Error("log"); },
  });
  assertEquals(r.covered, null);
});

Deno.test("coverageNeedsAlert: every unknown except list_not_configured; never for a decided order", () => {
  assertEquals(coverageNeedsAlert({ covered: true, reason: "covered", state: "IN" }), false);
  assertEquals(coverageNeedsAlert({ covered: false, reason: "excluded_state", state: "NY" }), false);
  assertEquals(coverageNeedsAlert({ covered: null, reason: "list_not_configured", state: null }), false);
  for (const reason of ["list_malformed", "list_read_failed", "claim_read_failed", "no_property_state"] as const) {
    assertEquals(coverageNeedsAlert({ covered: null, reason, state: null }), true, reason);
  }
});

Deno.test("buildCoverageAlertRow: validated ids only; promises nothing", () => {
  const row = buildCoverageAlertRow(
    { reason: "no_property_state", orderId: "11111111-2222-4333-8444-555555555555", paymentIntentId: "pi_<script>", claimId: "nope" },
    () => new Date("2026-11-09T00:00:00Z"),
  );
  assertEquals(row.alert_type, "guarantee_coverage_unknown");
  assertEquals(row.function_name, "create-measurement-order");
  assertEquals(row.sent_at, "2026-11-09T00:00:00.000Z");
  assertStringIncludes(row.message, "order 11111111-2222-4333-8444-555555555555");
  assertStringIncludes(row.message, "payment_intent unrecognized");
  assertStringIncludes(row.message, "claim unrecognized");
});

Deno.test("raiseCoverageAlert never throws (insert error, insert throw)", async () => {
  const logs: string[] = [];
  const row = buildCoverageAlertRow({ reason: "list_read_failed", orderId: null, paymentIntentId: null, claimId: null });
  await raiseCoverageAlert(() => Promise.resolve({ error: { code: "x" } }), (m) => logs.push(m), row);
  await raiseCoverageAlert(() => { throw new Error("x"); }, (m) => logs.push(m), row);
  assertEquals(logs.length, 2);
});
