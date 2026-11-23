// Deno unit tests for gh-1759's forward-guard alert rule.
// Run: deno test supabase/functions/platform-health-check/charged-fee-no-charge-id-check.test.ts
// FAIL-FIRST / NEGATIVE CONTROL: on origin/main the module does not exist, so this file fails to import.
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  CHARGED_FEE_ALERT_TYPE,
  evaluateChargedFeeWithoutChargeId,
  findChargedFeesWithoutChargeId,
  shouldAlertOnChargedFee,
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

// ---- review fixes (REVIEW 7087416804): standing-condition throttle ----
Deno.test("a standing row alerts once; second run stays silent, even after acknowledge; new row alerts; reminder after 24h", () => {
  const NOW = new Date("2026-11-22T18:00:00Z");
  const one = findChargedFeesWithoutChargeId([c("stuck-1", { platform_fee_stripe_id: null })]);
  // never alerted -> alert
  assertEquals(shouldAlertOnChargedFee(one, null, { now: NOW }).alert, true);
  // first run's alert is logged (message names the id); the next run, 15 minutes later, is silent
  const msg = evaluateChargedFeeWithoutChargeId(one)!.message;
  const last = { sent_at: "2026-11-22T17:45:00Z", message: msg };
  assertEquals(shouldAlertOnChargedFee(one, last, { now: NOW }), { alert: false, newCount: 0 });
  // acknowledging only sets acknowledged_at on that row; the throttle reads the row regardless, so still silent
  assertEquals(shouldAlertOnChargedFee(one, { ...last, acknowledged_at: "2026-11-22T17:50:00Z" } as typeof last, { now: NOW }).alert, false);
  // a NEW offending claim alerts
  const two = findChargedFeesWithoutChargeId([c("stuck-1", { platform_fee_stripe_id: null }), c("stuck-2", { platform_fee_stripe_id: "" })]);
  assertEquals(shouldAlertOnChargedFee(two, last, { now: NOW }), { alert: true, newCount: 1 });
  // daily reminder: 23h silent, 24h+ alerts
  assertEquals(shouldAlertOnChargedFee(one, { ...last, sent_at: "2026-11-21T19:00:00Z" }, { now: NOW }).alert, false);
  assertEquals(shouldAlertOnChargedFee(one, { ...last, sent_at: "2026-11-21T17:59:00Z" }, { now: NOW }).alert, true);
  // no offending rows -> never; proof run (force) -> always
  assertEquals(shouldAlertOnChargedFee({ count: 0, claims: [] }, null, { now: NOW }).alert, false);
  assertEquals(shouldAlertOnChargedFee(one, last, { now: NOW, force: true }).alert, true);
});
