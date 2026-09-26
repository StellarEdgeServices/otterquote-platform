// [gh-1886 re-review #2, independent review on #2198, 2026-09-25T22:02:35Z -- "B1-c"]
//
// Shows the BEFORE/AFTER of the dunning path this rework requires:
//   BEFORE (the head that was just returned, ba263c4e): create-payment-intent had no distinct code for an
//   ambiguous outcome at all -- an AmbiguousChargeOutcomeError there was uncaught and fell into the
//   generic `catch (error)` -> a plain 500 `{error}`. That response classifies as "hard_failure" below
//   (there is no 422 + AMBIGUOUS_OUTCOME_CODE to recognise), and shouldTriggerDunning("hard_failure") is
//   true -- so docusign-webhook WOULD have triggered dunning, which charges the same contractor again
//   under a different Idempotency-Key.
//   AFTER (this rework): create-payment-intent returns 422 + AMBIGUOUS_OUTCOME_CODE for that same error.
//   classifyPlatformFeeErrorResponse now recognises it as "ambiguous_outcome", and
//   shouldTriggerDunning("ambiguous_outcome") is false -- dunning is never triggered.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  classifyPlatformFeeErrorResponse,
  extractIdempotencyKeyHint,
  shouldTriggerDunning,
} from "./payment-response-classify.ts";

const GUARD_REFUSAL_CODE = "TEST_CLAIM_CHARGE_REFUSED";
const AMBIGUOUS_OUTCOME_CODE = "PLATFORM_FEE_CHARGE_OUTCOME_UNKNOWN";

Deno.test("gh-1886 B1-c BEFORE (head ba263c4e): a generic 500 with no distinguishing code classifies as hard_failure -- the pre-fix double-charge route", () => {
  const body = JSON.stringify({ error: "Stripe create outcome is ambiguous for Idempotency-Key plat-fee-c1-ctr1-pm_A..." });
  assertEquals(classifyPlatformFeeErrorResponse(500, body, GUARD_REFUSAL_CODE, AMBIGUOUS_OUTCOME_CODE), "hard_failure");
});

Deno.test("gh-1886 B1-c AFTER: a 422 carrying AMBIGUOUS_OUTCOME_CODE classifies as ambiguous_outcome, distinct from a hard_failure and from a guard refusal", () => {
  const body = JSON.stringify({
    error: "Stripe create outcome is ambiguous...",
    code: AMBIGUOUS_OUTCOME_CODE,
    idempotency_key: "plat-fee-c1-ctr1-pm_A",
  });
  assertEquals(classifyPlatformFeeErrorResponse(422, body, GUARD_REFUSAL_CODE, AMBIGUOUS_OUTCOME_CODE), "ambiguous_outcome");
});

Deno.test("gh-1886: a 422 carrying the existing #1467 guard refusal code still classifies as guard_refused -- unaffected by this change", () => {
  const body = JSON.stringify({ error: "live platform-fee charge REFUSED...", code: GUARD_REFUSAL_CODE });
  assertEquals(classifyPlatformFeeErrorResponse(422, body, GUARD_REFUSAL_CODE, AMBIGUOUS_OUTCOME_CODE), "guard_refused");
});

Deno.test("gh-1886: a 422 that carries NEITHER code (unrecognised) still falls back to hard_failure -- fail-closed on classification, not on the charge itself", () => {
  const body = JSON.stringify({ error: "some other 422 this function does not specifically recognise" });
  assertEquals(classifyPlatformFeeErrorResponse(422, body, GUARD_REFUSAL_CODE, AMBIGUOUS_OUTCOME_CODE), "hard_failure");
});

Deno.test("gh-1886: an ordinary decline (e.g. 402, or any other non-422 status) classifies as hard_failure -- unchanged, dunning is exactly right for this case", () => {
  const body = JSON.stringify({ error: "Stripe API error (HTTP 402): Your card was declined." });
  assertEquals(classifyPlatformFeeErrorResponse(402, body, GUARD_REFUSAL_CODE, AMBIGUOUS_OUTCOME_CODE), "hard_failure");
});

Deno.test("gh-1886 B1-c BEFORE/AFTER: only a hard_failure classification triggers dunning; guard_refused and ambiguous_outcome never do", () => {
  assertEquals(
    shouldTriggerDunning("hard_failure"),
    true,
    "a genuine decline must still reach dunning -- this is the ONLY classification allowed to",
  );
  assertEquals(shouldTriggerDunning("guard_refused"), false, "unchanged: a guard refusal never attempted a charge");
  assertEquals(
    shouldTriggerDunning("ambiguous_outcome"),
    false,
    "AFTER fix: an ambiguous outcome must NEVER trigger dunning -- process-dunning would charge the same " +
      "contractor again under a DIFFERENT Idempotency-Key, seconds later, with no human involved",
  );
});

Deno.test("extractIdempotencyKeyHint: reads the idempotency_key field out of the ambiguous-outcome JSON body", () => {
  const body = JSON.stringify({ error: "...", code: AMBIGUOUS_OUTCOME_CODE, idempotency_key: "plat-fee-c1-ctr1-pm_A" });
  assertEquals(extractIdempotencyKeyHint(body), "plat-fee-c1-ctr1-pm_A");
});

Deno.test("extractIdempotencyKeyHint: falls back to 'unknown' on malformed JSON or a missing/blank field, never throws", () => {
  assertEquals(extractIdempotencyKeyHint("not json at all"), "unknown");
  assertEquals(extractIdempotencyKeyHint(JSON.stringify({ error: "no key field here" })), "unknown");
  assertEquals(extractIdempotencyKeyHint(JSON.stringify({ idempotency_key: "" })), "unknown");
  assertEquals(extractIdempotencyKeyHint(JSON.stringify({ idempotency_key: 12345 })), "unknown");
});
