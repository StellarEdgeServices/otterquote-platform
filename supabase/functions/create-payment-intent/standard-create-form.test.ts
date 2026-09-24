// gh-2078c / D-330 -- the standard-flow create body is main's, byte for byte, and nothing per-request can reach it.
// The extraction of the body into buildStandardCreateForm() must not change one byte of what Stripe receives, so this is a
// DIFFERENTIAL test: a literal copy of main's inline construction (the reference) is compared with the module across a
// matrix of inputs, and a per-request field (the variant) is proven to have no influence.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildStandardCreateForm, standardIdempotencyKey } from "./standard-create-form.ts";
import { UPGRADE_CHARGE_DESCRIPTION, VENDOR_CREDIT_EXPECTED_CENTS } from "./measurement-upgrade-gate.ts";

// REFERENCE: main's create-payment-intent/index.ts standard flow, copied verbatim (2d1ab1ed / 7982f54f).
// deno-lint-ignore no-explicit-any
function mainForm(amount: unknown, currency: string, description: string | null | undefined, metadata: any, contractor_id: unknown): string {
  const form = new URLSearchParams();
  form.append("amount", String(amount));
  form.append("currency", currency);
  const chargeDescription = metadata.type === "measurement_upgrade"
    ? UPGRADE_CHARGE_DESCRIPTION
    : (description || "");
  form.append("description", chargeDescription);
  form.append("metadata[claim_id]", metadata.claim_id);
  form.append("metadata[type]", metadata.type);
  if (metadata.type === "measurement_upgrade") {
    form.append("metadata[contractor_id]", contractor_id as string);
    form.append("metadata[vendor_credit_expected_cents]", String(VENDOR_CREDIT_EXPECTED_CENTS));
  }
  form.append("automatic_payment_methods[enabled]", "true");
  return form.toString();
}

const TYPES = ["hover_measurement", "deductible_escrow", "measurement_upgrade"];
const DESCRIPTIONS: (string | null | undefined)[] = ["Complete Property Report", "", null, undefined, "Deductible escrow"];
const AMOUNTS: unknown[] = [1500, 2500, 5500, 0, "1500"];
const CLAIMS = ["c0ffee00-0000-4000-8000-000000000001", "x", undefined];
const CONTRACTORS: unknown[] = ["ct-1", undefined, null];

Deno.test("the module's create body equals main's construction for every combination of type, description, amount, claim and contractor", () => {
  let n = 0;
  for (const type of TYPES) for (const d of DESCRIPTIONS) for (const a of AMOUNTS) for (const c of CLAIMS) for (const k of CONTRACTORS) {
    const metadata = { type, claim_id: c };
    const got = buildStandardCreateForm({ amount: a, currency: "usd", description: d, metadata, contractor_id: k }).toString();
    assertEquals(got, mainForm(a, "usd", d, metadata, k), JSON.stringify({ type, d, a, c, k }));
    n++;
  }
  assert(n === TYPES.length * DESCRIPTIONS.length * AMOUNTS.length * CLAIMS.length * CONTRACTORS.length && n > 400, String(n));
});

Deno.test("nothing per-request reaches the create: variant, gpc and any other metadata field change neither the body nor the key", () => {
  const base = { type: "hover_measurement", claim_id: "c0ffee00-0000-4000-8000-000000000001" };
  const ref = buildStandardCreateForm({ amount: 1500, currency: "usd", description: "Complete Property Report", metadata: base }).toString();
  for (const extra of [{ variant: "e" }, { variant: "unknown" }, { variant: "f" }, { variant: "<script>" }, { gpc: true }, { variant: "e", gpc: true, anything: "else" }]) {
    const md = { ...base, ...extra };
    assertEquals(buildStandardCreateForm({ amount: 1500, currency: "usd", description: "Complete Property Report", metadata: md }).toString(), ref, JSON.stringify(extra));
    assertEquals(standardIdempotencyKey(md), standardIdempotencyKey(base), JSON.stringify(extra));
  }
});

Deno.test("the create's parameter set is exactly main's", () => {
  const keys = (type: string) => [...buildStandardCreateForm({ amount: 1, currency: "usd", description: "d", metadata: { type, claim_id: "c" }, contractor_id: "x" }).keys()];
  assertEquals(keys("hover_measurement"), ["amount", "currency", "description", "metadata[claim_id]", "metadata[type]", "automatic_payment_methods[enabled]"]);
  assertEquals(keys("deductible_escrow"), keys("hover_measurement"));
  assertEquals(keys("measurement_upgrade"), ["amount", "currency", "description", "metadata[claim_id]", "metadata[type]", "metadata[contractor_id]", "metadata[vendor_credit_expected_cents]", "automatic_payment_methods[enabled]"]);
});

Deno.test("the idempotency key is one key per claim and type", () => {
  assertEquals(standardIdempotencyKey({ type: "hover_measurement", claim_id: "abc" }), "hover_measurement-abc");
});

// -- index.ts uses them, and only them -------------------------------------------------------------
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("index.ts builds the standard create with buildStandardCreateForm and the key with standardIdempotencyKey, and no longer inlines either", () => {
  assert(index.includes('from "./standard-create-form.ts"'));
  assertEquals(index.split("buildStandardCreateForm(").length - 1, 1);
  assertEquals(index.split("standardIdempotencyKey(").length - 1, 1);
  const std = index.slice(index.indexOf("// ===== Standard flow"), index.indexOf("// gh-948: 'processing' (ACH in flight)"));
  assert(!std.includes("metadata[variant]"), "no variant in the standard flow's create");
  assert(!std.includes("const form = new URLSearchParams();"), "the inline form is gone");
  assert(!std.includes("`${metadata.type}-${metadata.claim_id}`"), "the inline key is gone");
});
