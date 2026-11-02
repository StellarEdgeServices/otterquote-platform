// gh-3293 — pick the Stripe secret key for a charge, respecting the claim.
//
// DEFECT. create-payment-intent chose the key from the request Origin alone
// (TEST key only for the staging origins). docusign-webhook calls it with no
// Origin, so that path always got the LIVE key. On a claim with is_test = true
// the flag only decided whether a charge was ALLOWED (live-charge-guard.ts); once
// live_charge_authorized_at was set the charge ran on the LIVE key.
//
// RULE. An is_test claim NEVER uses the LIVE key, whatever the Origin and whether
// or not live_charge_authorized_at is set. If STRIPE_SECRET_KEY_TEST is missing
// for an is_test claim, refuse (no fallback to the live key). Non-test claims keep
// the pre-existing behaviour exactly.
//
// SHARED by create-payment-intent and process-dunning (TRIGGER mode; the CRON retry pass applies the same
// rule per claim in retry-pass.ts). Both read the claim's is_test SERVER-SIDE from the DB, never from the request.
//
// Pure (env is passed in) so it is unit-testable without a network.

export type StripeKeyRefusalReason =
  | "test_key_missing_for_test_claim"
  | "test_key_not_a_test_key_for_test_claim";
export type StripeKeyChoice =
  | { ok: true; key: string; mode: "test" | "live" }
  | { ok: false; reason: StripeKeyRefusalReason | "key_not_configured" };

/** True for the refusals that mean "this is_test claim has no usable TEST key" (do-not-dun; see keyRefusalResponse). */
export function isTestClaimKeyRefusal(reason: string): reason is StripeKeyRefusalReason {
  return reason === "test_key_missing_for_test_claim" || reason === "test_key_not_a_test_key_for_test_claim";
}

/**
 * The HTTP refusal create-payment-intent returns when selectStripeKey refuses. A test-claim key refusal is 422 and
 * carries the caller-supplied REFUSAL_CODE (live-charge-guard.ts) so docusign-webhook's payment-response-classify.ts
 * classifies it "guard_refused" (never dunned: no charge was attempted). Anything else stays the old 500.
 */
export function keyRefusalResponse(
  reason: StripeKeyRefusalReason | "key_not_configured",
  refusalCode: string,
): { status: number; body: Record<string, unknown> } {
  if (isTestClaimKeyRefusal(reason)) {
    return { status: 422, body: { error: "Stripe key not available for this claim.", reason, code: refusalCode } };
  }
  return { status: 500, body: { error: "Stripe key not available for this claim.", reason } };
}

export function selectStripeKey(args: {
  isStaging: boolean;
  claimIsTest: boolean;
  env: (name: string) => string | undefined;
}): StripeKeyChoice {
  const testKey = args.env("STRIPE_SECRET_KEY_TEST");
  const liveKey = args.env("STRIPE_SECRET_KEY");
  if (args.claimIsTest) {
    if (!testKey) return { ok: false, reason: "test_key_missing_for_test_claim" };
    // A mis-set secret (a live key stored as the TEST key) must not be used for an is_test claim (as retry-pass.ts).
    if (!(testKey.startsWith("sk_test_") || testKey.startsWith("rk_test_"))) {
      return { ok: false, reason: "test_key_not_a_test_key_for_test_claim" };
    }
    return { ok: true, key: testKey, mode: "test" };
  }
  // Unchanged pre-existing behaviour for real claims.
  if (args.isStaging) {
    const k = testKey || liveKey;
    return k ? { ok: true, key: k, mode: testKey ? "test" : "live" } : { ok: false, reason: "key_not_configured" };
  }
  return liveKey ? { ok: true, key: liveKey, mode: "live" } : { ok: false, reason: "key_not_configured" };
}
