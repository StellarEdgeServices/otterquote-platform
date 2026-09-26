// gh-2078c / D-330 -- REVIEW: FAIL 5805531419 on #2110, B1, N1.
//
// B1: `metadata[variant]` was appended to the PaymentIntent CREATE form, and that create carries
//     `Idempotency-Key: <type>-<claim_id>` -- one key per claim, reused on every Purchase click and every retry. Stripe
//     compares a reused key's parameters with the first request's and, when they differ, answers HTTP 400 idempotency_error
//     and creates nothing, for up to 24 hours. Before #2110 every create parameter was fixed per claim; `variant` (the
//     browser's stored router arm, or 'unknown' from another device or the static checkout) is the first that varies. A
//     homeowner whose retry carries a different variant could not pay.
// FIX: the create form stays EXACTLY as it is on main (byte-identical for every claim); the variant is attached AFTERWARDS
//     with a separate, best-effort update of the PaymentIntent that sends only `metadata[variant]`.
// N1: the variant is shape-checked before it is forwarded (same rule as the webhook's sanitizeCapiVariant).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { attachVariantMetadata, sanitizeVariantForMetadata } from "./variant-metadata.ts";

// -- N1: the shape rule ------------------------------------------------------------------
Deno.test("sanitizeVariantForMetadata: a short lowercase alphanumeric token passes; everything else is 'unknown'", () => {
  for (const ok of ["a", "e", "f", "e2", "abcd1234"]) assertEquals(sanitizeVariantForMetadata(ok), ok);
  for (const bad of ["", "E", "a-b", "has space", "abcdefghi", "x".repeat(500), "<script>", "a\nb", 5, null, undefined, {}, ["a"]]) {
    assertEquals(sanitizeVariantForMetadata(bad), "unknown", JSON.stringify(bad));
  }
});

// -- the separate attach -------------------------------------------------------------------
interface Call { url: string; init: RequestInit }
function fakeFetch(res: { ok: boolean; status: number } | "throw"): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (res === "throw") return Promise.reject(new Error("network down https://api.stripe.com/secret"));
    return Promise.resolve({ ok: res.ok, status: res.status, text: () => Promise.resolve("stripe body with secret") } as Response);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
async function attach(over: Partial<Parameters<typeof attachVariantMetadata>[0]> = {}, res: { ok: boolean; status: number } | "throw" = { ok: true, status: 200 }) {
  const { fetchFn, calls } = fakeFetch(res);
  const logs: string[] = [];
  const outcome = await attachVariantMetadata({
    fetchFn, apiBase: "https://api.stripe.com/v1", basicAuth: "QUJD", paymentIntentId: "pi_123", status: "requires_payment_method",
    variant: "e", log: (m) => logs.push(m), ...over,
  });
  return { outcome, calls, logs };
}

Deno.test("attachVariantMetadata: POSTs ONLY metadata[variant] to the PaymentIntent update endpoint, with the Stripe auth", async () => {
  const r = await attach();
  assertEquals(r.outcome, "attached");
  assertEquals(r.calls.length, 1);
  assertEquals(r.calls[0].url, "https://api.stripe.com/v1/payment_intents/pi_123");
  assertEquals(r.calls[0].init.method, "POST");
  const body = new URLSearchParams(String(r.calls[0].init.body));
  assertEquals([...body.keys()], ["metadata[variant]"], "the update carries no other parameter");
  assertEquals(body.get("metadata[variant]"), "e");
  const h = r.calls[0].init.headers as Record<string, string>;
  assertEquals(h.Authorization, "Basic QUJD");
  assert(!("Idempotency-Key" in h), "the update carries no idempotency key: it is a naturally idempotent set of one value");
});

Deno.test("attachVariantMetadata: an unusable variant is sent as 'unknown', never the raw value", async () => {
  const r = await attach({ variant: "X".repeat(400) });
  assertEquals(new URLSearchParams(String(r.calls[0].init.body)).get("metadata[variant]"), "unknown");
});

Deno.test("attachVariantMetadata: a PaymentIntent that is already succeeded or canceled is left alone (no call)", async () => {
  for (const status of ["succeeded", "canceled"]) {
    const r = await attach({ status });
    assertEquals(r.outcome, "skipped_status", status);
    assertEquals(r.calls.length, 0);
  }
  for (const status of ["requires_payment_method", "requires_confirmation", "requires_action", "processing"]) {
    assertEquals((await attach({ status })).outcome, "attached", status);
  }
});

Deno.test("attachVariantMetadata: a Stripe error or a network failure is swallowed (payment unaffected) and logged with a FIXED message only", async () => {
  const bad = await attach({}, { ok: false, status: 400 });
  assertEquals(bad.outcome, "failed");
  assert(bad.logs.length === 1 && bad.logs[0].includes("HTTP 400") && bad.logs[0].includes("payment unaffected"));
  const thrown = await attach({}, "throw");
  assertEquals(thrown.outcome, "failed");
  const all = bad.logs.join(" | ") + thrown.logs.join(" | ");
  assert(!all.includes("secret") && !all.includes("api.stripe.com"), "no Stripe body, no URL, no error text in the log: " + all);
});

// -- structure of index.ts ---------------------------------------------------------------------
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const stdStart = index.indexOf("// ===== Standard flow (hover_measurement, deductible_escrow, measurement_upgrade) =====");
const stdEnd = index.indexOf("// gh-948: 'processing' (ACH in flight)", stdStart);
const standard = index.slice(stdStart, stdEnd);

Deno.test("B1: the standard-flow create is built by the pure builder (whose parameter set standard-create-form.test.ts pins to main's), with no variant and no inline form", () => {
  assert(stdStart > 0 && stdEnd > stdStart);
  assert(standard.includes("buildStandardCreateForm({ amount, currency, description, metadata, contractor_id })"));
  assert(!standard.includes("form.append("), "no inline form parameters remain in the standard flow");
  assert(!standard.includes("metadata[variant]"), "metadata[variant] is not in the keyed create");
});

Deno.test("B1: the create's idempotency key is still one key per claim and type", () => {
  assert(standard.includes("const idempotencyKey = standardIdempotencyKey(metadata);"));
});

Deno.test("B1: the variant is attached AFTER the create returns, only for hover_measurement, via attachVariantMetadata", () => {
  const createdAt = standard.indexOf("paymentIntentData = await r.json();");
  const attachAt = standard.indexOf("attachVariantMetadata(");
  assert(createdAt > 0 && attachAt > createdAt, "attach comes after the create response is read");
  assertEquals(standard.split("attachVariantMetadata(").length - 1, 1);
  const before = standard.slice(createdAt, attachAt);
  assert(before.includes('metadata.type === "hover_measurement"'), "scoped to hover_measurement");
  assert(index.includes('from "./variant-metadata.ts"'));
});

Deno.test("B1: the attach is best-effort: not able to throw into the payment path", () => {
  const attachAt = standard.indexOf("attachVariantMetadata(");
  const stmt = standard.slice(Math.max(0, attachAt - 200), attachAt + 500);
  assert(stmt.includes("await attachVariantMetadata("), "awaited (the client confirms only after client_secret, so it must be in place first)");
});

// -- REVIEW: FAIL 5806828503 F2 on #2134: a failed profile write must not fail toward SHARING -------------------------------
Deno.test("F2: with optOut the update carries metadata[ad_sharing_opt_out]=1 next to the variant, and nothing else", async () => {
  const r = await attach({ optOut: true });
  assertEquals(r.outcome, "attached");
  const body = new URLSearchParams(String(r.calls[0].init.body));
  assertEquals([...body.keys()].sort(), ["metadata[ad_sharing_opt_out]", "metadata[variant]"]);
  assertEquals(body.get("metadata[ad_sharing_opt_out]"), "1");
  assertEquals(body.get("metadata[variant]"), "e");
});

Deno.test("F2: without optOut (absent or false) the update carries ONLY metadata[variant], exactly as before", async () => {
  for (const over of [{}, { optOut: false }, { optOut: undefined }]) {
    const r = await attach(over);
    assertEquals([...new URLSearchParams(String(r.calls[0].init.body)).keys()], ["metadata[variant]"], JSON.stringify(over));
  }
});

Deno.test("F2: only the boolean true carries the signal (a truthy string never does)", async () => {
  for (const v of ["1", "true", 1, "yes"]) {
    const r = await attach({ optOut: v as unknown as boolean });
    assert(!new URLSearchParams(String(r.calls[0].init.body)).has("metadata[ad_sharing_opt_out]"), String(v));
  }
});

Deno.test("F2: the signal is attached even when the profile write is not involved at all (index.ts derives it from the request, not from the store outcome)", () => {
  const callAt = standard.indexOf("attachVariantMetadata(");
  const call = standard.slice(callAt, standard.indexOf("});", callAt) + 3);
  assert(/optOut:\s*gpcSignalPresent/.test(call), "the attach call passes optOut: gpcSignalPresent: " + call);
  const gpc = index.slice(index.indexOf("const gpcStore"), index.indexOf("// D-181: server-side price enforcement"));
  assert(/const gpcSignalPresent = detectGpcSignal\(req\.headers, requestBody\) !== null;/.test(gpc), "computed from the request alone: " + gpc.slice(0, 300));
  assert(!/gpcSignalPresent\s*=\s*[^;]*recordGpcOptOut/.test(gpc), "not derived from the store outcome");
});
