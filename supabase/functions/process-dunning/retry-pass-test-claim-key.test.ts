// gh-3293 (REVIEW 6548365782 A, C): the CRON retry pass must never reach the LIVE key for an is_test claim, even when
// DUNNING_RETRY_PASS_LIVE=true and the claim carries live_charge_authorized_at. Drives the REAL runRetryPass and the
// REAL buildRetryPassDeps (key mode derived from the key). NEGATIVE CONTROL: on main there is no keyMode/isTest check,
// so the live-key pass charges the authorised is_test claim and "no charge" FAILS against main's logic.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runRetryPass, selectRetryStripeKey } from "./retry-pass.ts";
import type { RetryPassDeps } from "./retry-pass.ts";
import { buildRetryPassDeps } from "./retry-pass-supabase.ts";

const NOW = new Date("2026-10-20T15:00:00Z");
const iso = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60000).toISOString();
const row = () => ({
  id: "r1", quote_id: "q1", contractor_id: "c1", claim_id: "cl1", amount_cents: 18000, dunning_status: "active",
  resolved_at: null, homeowner_notify_at: new Date(NOW.getTime() + 20 * 3600000).toISOString(),
  retry_requested_at: iso(5), retry_request_count: 1, retry_handled_at: null,
});

// deno-lint-ignore no-explicit-any
function makeDeps(keyMode: "test" | "live" | undefined, isTest: boolean | undefined, over: Record<string, any> = {}) {
  const log = { charges: 0, alerts: [] as string[], handled: 0 };
  const rows = over.rows ?? [row()];
  const deps = {
    now: () => NOW, keyMode,
    listCandidateRows: async () => rows,
    markHandled: async (ids: string[]) => { log.handled++; return ids.length; },
    refundRequest: async () => true,
    markUnknown: async (ids: string[]) => ids.length,
    clearUnknown: async (ids: string[]) => ids.length,
    acquireLease: async () => "tok", releaseLease: async () => {},
    markStuckAlerted: async (ids: string[]) => ids.length,
    retrieveIntent: async () => ({ status: "succeeded" }),
    countOpenRows: async () => 1,
    getQuotePaymentStatus: async () => "failed",
    chargeGuard: async () => ({ allow: true, message: "", isTest }),
    getChargeMethods: async () => ({ customerId: "cus_1", methods: [{ stripe_pm_id: "pm_card1", payment_type: "card", cpm_id: "cpm1" }] }),
    charge: async () => { log.charges++; return { status: "succeeded", paymentIntentId: "pi_1", declineCode: null, message: null }; },
    recordQuoteResult: async () => true, closeDunningRows: async (ids: string[]) => ids.length,
    alert: async (t: string) => { log.alerts.push(t); },
    ...over.deps,
  } as unknown as RetryPassDeps;
  return { deps, log };
}

Deno.test("live-key pass + is_test claim (authorised) -> refused, NO Stripe charge, alert raised", async () => {
  const { deps, log } = makeDeps("live", true);
  const out = await runRetryPass(deps);
  assertEquals(log.charges, 0);
  assertEquals(out[0], { quoteKey: out[0].quoteKey, outcome: "refused", reason: "is_test_claim_live_key" });
  assert(log.alerts.includes("dunning_retry_refused_test_claim_live_key"));
});
Deno.test("live-key pass + is_test UNKNOWN -> refused (fail closed)", async () => {
  const { deps, log } = makeDeps("live", undefined);
  await runRetryPass(deps);
  assertEquals(log.charges, 0);
});
Deno.test("live-key pass + REAL claim (isTest false) -> still charged (real claims unchanged)", async () => {
  const { deps, log } = makeDeps("live", false);
  const out = await runRetryPass(deps);
  assertEquals(log.charges, 1);
  assertEquals(out[0].outcome, "charged");
});
Deno.test("test-key pass + is_test claim -> charged on the test key (allowed)", async () => {
  const { deps, log } = makeDeps("test", true);
  await runRetryPass(deps);
  assertEquals(log.charges, 1);
});
Deno.test("replay of an in-doubt attempt under the live key is refused for an is_test claim", async () => {
  const req = {
    quoteId: "q1", claimId: "cl1", contractorId: "c1", customerId: "cus_1", feeCents: 18000, chargeAmountCents: 18000,
    method: { stripe_pm_id: "pm_card1", payment_type: "card", cpm_id: "cpm1" }, idempotencyKey: "k1", requestedAtMs: 1,
  };
  const marked = { ...row(), retry_unknown_at: iso(10), retry_unknown_attempt: { req, attemptedAt: iso(10) } };
  const { deps, log } = makeDeps("live", true, { rows: [marked] });
  const out = await runRetryPass(deps);
  assertEquals(log.charges, 0);
  assertEquals(out[0], { quoteKey: out[0].quoteKey, outcome: "skipped", reason: "unknown_replay_test_claim_live_key" });
});
Deno.test("buildRetryPassDeps derives keyMode from the key prefix (a non-test key is live)", () => {
  const guard = { GUARD_SELECT: "id", evaluateLiveChargeGuard: () => ({ allow: true }), describeGuardVerdict: () => "" };
  assertEquals(buildRetryPassDeps({}, "sk_test_x", guard).keyMode, "test");
  assertEquals(buildRetryPassDeps({}, "rk_test_x", guard).keyMode, "test");
  assertEquals(buildRetryPassDeps({}, "sk_live_x", guard).keyMode, "live");
});
Deno.test("selectRetryStripeKey: live mode still hands out only a non-test key (the claim rule above is what guards is_test)", () => {
  const env = (m: Record<string, string>) => (n: string) => m[n];
  const r = selectRetryStripeKey(env({ DUNNING_RETRY_PASS_LIVE: "true", STRIPE_SECRET_KEY: "sk_live_x" }));
  assert(r.ok && r.mode === "live");
});
