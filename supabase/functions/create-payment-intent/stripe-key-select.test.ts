// gh-3293 — an is_test claim must never be charged on the LIVE Stripe key.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { selectStripeKey } from "./stripe-key-select.ts";

const env = (m: Record<string, string>) => (n: string) => m[n];
const BOTH = env({ STRIPE_SECRET_KEY: "sk_live_X", STRIPE_SECRET_KEY_TEST: "sk_test_X" });

Deno.test("(a) is_test + no Origin (production path, e.g. docusign-webhook) -> TEST key", () => {
  const r = selectStripeKey({ isStaging: false, claimIsTest: true, env: BOTH });
  assert(r.ok);
  assertEquals(r.key, "sk_test_X");
  assertEquals(r.mode, "test");
});

Deno.test("(b) is_test + live_charge_authorized_at set -> still TEST key (marker does not pick the key)", () => {
  // The marker is not an input: key selection depends only on claimIsTest/Origin.
  const r = selectStripeKey({ isStaging: false, claimIsTest: true, env: BOTH });
  assert(r.ok && r.key === "sk_test_X");
});

Deno.test("is_test + TEST key missing -> refuse, never fall back to LIVE", () => {
  const r = selectStripeKey({ isStaging: false, claimIsTest: true, env: env({ STRIPE_SECRET_KEY: "sk_live_X" }) });
  assertEquals(r, { ok: false, reason: "test_key_missing_for_test_claim" });
  const s = selectStripeKey({ isStaging: true, claimIsTest: true, env: env({ STRIPE_SECRET_KEY: "sk_live_X" }) });
  assertEquals(s.ok, false);
});

Deno.test("(c) real claim keeps current behaviour", () => {
  const prod = selectStripeKey({ isStaging: false, claimIsTest: false, env: BOTH });
  assert(prod.ok && prod.key === "sk_live_X" && prod.mode === "live");
  const stg = selectStripeKey({ isStaging: true, claimIsTest: false, env: BOTH });
  assert(stg.ok && stg.key === "sk_test_X");
  const stgNoTest = selectStripeKey({ isStaging: true, claimIsTest: false, env: env({ STRIPE_SECRET_KEY: "sk_live_X" }) });
  assert(stgNoTest.ok && stgNoTest.key === "sk_live_X"); // pre-existing staging fallback, unchanged
  assertEquals(selectStripeKey({ isStaging: false, claimIsTest: false, env: env({}) }).ok, false);
});

Deno.test("(d) NEGATIVE CONTROL: old Origin-only selection hands an is_test claim the LIVE key; new selector does not", () => {
  const oldSelect = (isStaging: boolean, e: (n: string) => string | undefined) =>
    isStaging ? (e("STRIPE_SECRET_KEY_TEST") || e("STRIPE_SECRET_KEY")) : e("STRIPE_SECRET_KEY");
  assertEquals(oldSelect(false, BOTH), "sk_live_X"); // the defect, reproduced
  const r = selectStripeKey({ isStaging: false, claimIsTest: true, env: BOTH });
  assert(r.ok && r.key !== "sk_live_X");
});

Deno.test("wiring: index.ts selects the key via selectStripeKey with the claim's is_test", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(src.includes("selectStripeKey({"), "index.ts must call selectStripeKey");
  assert(src.includes("claimIsTest: unconditionalGuardClaim?.is_test === true"));
  assert(!/Deno\.env\.get\("STRIPE_SECRET_KEY"\)/.test(src), "index.ts must not read the live key directly");
});
