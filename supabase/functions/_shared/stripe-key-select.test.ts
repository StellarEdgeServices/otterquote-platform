// gh-3293 — an is_test claim must never be charged on the LIVE Stripe key.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { selectStripeKey } from "./stripe-key-select.ts";

const env = (m: Record<string, string>) => (n: string) => m[n];
const BOTH = env({ STRIPE_SECRET_KEY: "sk_live_X", STRIPE_SECRET_KEY_TEST: "sk_test_X" });
const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

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

Deno.test("is_test + a TEST key that is not sk_test_/rk_test_ (mis-set secret) -> refuse, never use it, never the live key", () => {
  for (const bad of ["sk_live_X", "pk_test_X", "garbage"]) {
    const r = selectStripeKey({ isStaging: false, claimIsTest: true, env: env({ STRIPE_SECRET_KEY: "sk_live_X", STRIPE_SECRET_KEY_TEST: bad }) });
    assertEquals(r, { ok: false, reason: "test_key_not_a_test_key_for_test_claim" });
  }
  const rk = selectStripeKey({ isStaging: false, claimIsTest: true, env: env({ STRIPE_SECRET_KEY_TEST: "rk_test_X" }) });
  assert(rk.ok && rk.key === "rk_test_X");
});

// (d) NEGATIVE CONTROL, REAL CODE PATH (REVIEW 6548365782 note 9): the old Origin-only pick is a source shape, and this
// test reads the real index.ts files. It FAILS against main (where both files contain that shape) and passes only once
// both call selectStripeKey with the claim's is_test. The behavioural controls drive the real handler
// (process-dunning/test-claim-key.test.ts, retry-pass-test-claim-key.test.ts).
const ORIGIN_ONLY_PICK = /isStaging\s*\?\s*\(?\s*(?:getEnv|Deno\.env\.get)\("STRIPE_SECRET_KEY_TEST"\)[^;]*?:\s*(?:getEnv|Deno\.env\.get)\("STRIPE_SECRET_KEY"\)/s;
Deno.test("(d) neither create-payment-intent nor process-dunning picks the Stripe key by Origin alone", async () => {
  const cpi = await read("../create-payment-intent/index.ts");
  const pd = await read("../process-dunning/index.ts");
  assert(!ORIGIN_ONLY_PICK.test(cpi), "create-payment-intent still has the Origin-only key pick");
  assert(!ORIGIN_ONLY_PICK.test(pd), "process-dunning still has the Origin-only key pick");
  // the pattern really matches the old shape (so the control cannot pass vacuously)
  assert(ORIGIN_ONLY_PICK.test('const k = isStaging ? (getEnv("STRIPE_SECRET_KEY_TEST") || getEnv("STRIPE_SECRET_KEY")) : getEnv("STRIPE_SECRET_KEY");'));
  assert(ORIGIN_ONLY_PICK.test('const k = isStaging ? (Deno.env.get("STRIPE_SECRET_KEY_TEST") || Deno.env.get("STRIPE_SECRET_KEY")) : Deno.env.get("STRIPE_SECRET_KEY");'));
});

Deno.test("wiring: create-payment-intent selects the key via selectStripeKey with the claim's is_test", async () => {
  const src = await read("../create-payment-intent/index.ts");
  assert(src.includes("selectStripeKey({"), "index.ts must call selectStripeKey");
  assert(src.includes("claimIsTest: unconditionalGuardClaim?.is_test === true"));
  assert(!/Deno\.env\.get\("STRIPE_SECRET_KEY"\)/.test(src), "index.ts must not read the live key directly");
});
Deno.test("wiring: process-dunning TRIGGER selects the key via selectStripeKey with the guard's server-side is_test", async () => {
  const src = await read("../process-dunning/index.ts");
  assert(src.includes("selectStripeKey({ isStaging, claimIsTest: triggerClaimIsTest, env: getEnv })"));
  assert(src.includes("triggerClaimIsTest = guardClaim?.is_test === true;"));
  assert(!/getEnv\("STRIPE_SECRET_KEY"\)/.test(src), "process-dunning/index.ts must not read the live key directly in TRIGGER mode");
});
