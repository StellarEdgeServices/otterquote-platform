// Deno unit tests for gh-1759's forward-guard alert rule.
// Run: deno test supabase/functions/platform-health-check/charged-fee-no-charge-id-check.test.ts
// FAIL-FIRST / NEGATIVE CONTROL: on origin/main the module does not exist, so this file fails to import.
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  CHARGED_FEE_ALERT_TYPE,
  evaluateChargedFeeWithoutChargeId,
  findChargedFeesWithoutChargeId,
  type ClaimFeeRow,
} from "./charged-fee-no-charge-id-check.ts";

const c = (id: string, over: Partial<ClaimFeeRow> = {}): ClaimFeeRow => ({
  id, created_at: "2026-11-09T12:00:00Z", platform_fee_charged: true, platform_fee_stripe_id: "ch_3Abc", is_test: false, ...over,
});

Deno.test("clean fixture (charged fees all carry a charge id; uncharged claims ignored) is silent", () => {
  const r = findChargedFeesWithoutChargeId([c("a"), c("b"), c("n", { platform_fee_charged: false, platform_fee_stripe_id: null })]);
  assertEquals(r.count, 0);
  assertEquals(evaluateChargedFeeWithoutChargeId(r), null);
});

Deno.test("planted row (charged, NULL charge id) fires and names the claim", () => {
  const r = findChargedFeesWithoutChargeId([c("a"), c("planted", { platform_fee_stripe_id: null })]);
  assertEquals(r.count, 1);
  const alert = evaluateChargedFeeWithoutChargeId(r);
  assertEquals(alert?.alertType, CHARGED_FEE_ALERT_TYPE);
  assertEquals(alert?.message.includes("planted"), true);
});

Deno.test("empty-string charge id also fires; platform_fee_charged null does not", () => {
  assertEquals(findChargedFeesWithoutChargeId([c("e", { platform_fee_stripe_id: "" })]).count, 1);
  assertEquals(findChargedFeesWithoutChargeId([c("x", { platform_fee_charged: null, platform_fee_stripe_id: null })]).count, 0);
});

Deno.test("is_test rows are invisible to the real alert, visible to the includeTest proof run", () => {
  const t = c("t", { platform_fee_stripe_id: null, is_test: true });
  assertEquals(findChargedFeesWithoutChargeId([t]).count, 0);
  const proof = findChargedFeesWithoutChargeId([t], true);
  assertEquals(proof.count, 1);
  assertEquals(evaluateChargedFeeWithoutChargeId(proof, true)?.message.includes("test-inclusive"), true);
});
