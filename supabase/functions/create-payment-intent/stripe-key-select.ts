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
// Pure (env is passed in) so it is unit-testable without a network.

export type StripeKeyChoice =
  | { ok: true; key: string; mode: "test" | "live" }
  | { ok: false; reason: "test_key_missing_for_test_claim" | "key_not_configured" };

export function selectStripeKey(args: {
  isStaging: boolean;
  claimIsTest: boolean;
  env: (name: string) => string | undefined;
}): StripeKeyChoice {
  const testKey = args.env("STRIPE_SECRET_KEY_TEST");
  const liveKey = args.env("STRIPE_SECRET_KEY");
  if (args.claimIsTest) {
    return testKey
      ? { ok: true, key: testKey, mode: "test" }
      : { ok: false, reason: "test_key_missing_for_test_claim" };
  }
  // Unchanged pre-existing behaviour for real claims.
  if (args.isStaging) {
    const k = testKey || liveKey;
    return k ? { ok: true, key: k, mode: testKey ? "test" : "live" } : { ok: false, reason: "key_not_configured" };
  }
  return liveKey ? { ok: true, key: liveKey, mode: "live" } : { ok: false, reason: "key_not_configured" };
}
