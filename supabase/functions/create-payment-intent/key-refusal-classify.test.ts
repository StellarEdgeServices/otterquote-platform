// gh-3293 (REVIEW 6548365782 B): create-payment-intent's refusal for an is_test claim with no usable TEST key must be
// recognised by docusign-webhook's classifier as do-not-dun. Uses the REAL helper, classifier and guard constant.
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { keyRefusalResponse, selectStripeKey } from "../_shared/stripe-key-select.ts";
import { classifyPlatformFeeErrorResponse, shouldTriggerDunning } from "../docusign-webhook/payment-response-classify.ts";
import { REFUSAL_CODE } from "./live-charge-guard.ts";
import { AMBIGUOUS_OUTCOME_CODE as AMBIGUOUS } from "./stripe-fetch.ts";

const env = (m: Record<string, string>) => (n: string) => m[n];

Deno.test("test-claim key refusals (missing, or not a test key) are 422 + REFUSAL_CODE and never classify as hard_failure", () => {
  for (const e of [env({ STRIPE_SECRET_KEY: "sk_live_X" }), env({ STRIPE_SECRET_KEY: "sk_live_X", STRIPE_SECRET_KEY_TEST: "sk_live_Y" })]) {
    const choice = selectStripeKey({ isStaging: false, claimIsTest: true, env: e });
    assert(!choice.ok);
    const r = keyRefusalResponse(choice.reason, REFUSAL_CODE);
    assertEquals(r.status, 422);
    assertEquals(r.body.code, REFUSAL_CODE);
    const cls = classifyPlatformFeeErrorResponse(r.status, JSON.stringify(r.body), REFUSAL_CODE, AMBIGUOUS);
    assertNotEquals(cls, "hard_failure");
    assertEquals(cls, "guard_refused");
    assertEquals(shouldTriggerDunning(cls), false);
  }
});
Deno.test("a real-claim key_not_configured stays a 500 hard_failure (unchanged behaviour)", () => {
  const r = keyRefusalResponse("key_not_configured", REFUSAL_CODE);
  assertEquals(r.status, 500);
  assertEquals("code" in r.body, false);
  assertEquals(classifyPlatformFeeErrorResponse(r.status, JSON.stringify(r.body), REFUSAL_CODE, AMBIGUOUS), "hard_failure");
});
Deno.test("wiring: create-payment-intent/index.ts builds the refusal with keyRefusalResponse(…, REFUSAL_CODE)", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(src.includes("keyRefusalResponse(keyChoice.reason, REFUSAL_CODE)"));
});
