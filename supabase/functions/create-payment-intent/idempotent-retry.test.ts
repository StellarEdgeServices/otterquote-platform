// gh-2078c / D-330 -- REVIEW: FAIL 5805870455 (F2) on #2110, the test Ben's ruling (#2078 5805593465) asks for:
// "retry the same claim with a different variant and show there is no 400."
//
// Drives the REAL create-body builder, the REAL idempotency-key function and the REAL attachVariantMetadata against a fake
// Stripe that behaves like Stripe's documented idempotency: a reused `Idempotency-Key` with a DIFFERENT body is refused with
// HTTP 400 `idempotency_error`, and with the SAME body returns the first response. The sequence is the one a homeowner hits:
// start on one device, retry on another, or come back through a different ?v= link.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildStandardCreateForm, standardIdempotencyKey } from "./standard-create-form.ts";
import { attachVariantMetadata } from "./variant-metadata.ts";

interface Recorded { method: string; url: string; key: string | null; body: string }

function fakeStripe() {
  const calls: Recorded[] = [];
  const byKey = new Map<string, { body: string; pi: { id: string; status: string } }>();
  const intents = new Map<string, Record<string, string>>();
  let n = 0;
  const fetchFn = ((url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const key = headers["Idempotency-Key"] ?? null;
    const body = String(init.body ?? "");
    calls.push({ method: String(init.method), url, key, body });
    const json = (status: number, obj: unknown) =>
      Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }));
    if (url.endsWith("/payment_intents")) {
      if (key && byKey.has(key)) {
        const first = byKey.get(key)!;
        if (first.body !== body) {
          return json(400, { error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." } });
        }
        return json(200, first.pi); // replay: the FIRST response, status included
      }
      const pi = { id: `pi_${++n}`, status: "requires_payment_method" };
      intents.set(pi.id, Object.fromEntries(new URLSearchParams(body)));
      if (key) byKey.set(key, { body, pi });
      return json(200, pi);
    }
    const m = url.match(/\/payment_intents\/(pi_\d+)$/);
    if (m) {
      const cur = intents.get(m[1]);
      if (!cur) return json(404, { error: { type: "invalid_request_error" } });
      for (const [k, v] of new URLSearchParams(body)) cur[k] = v;
      return json(200, { id: m[1] });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { fetchFn, calls, intents };
}

const API = "https://api.stripe.com/v1";
const CLAIM = "c0ffee00-0000-4000-8000-000000000001";

/** The sequence index.ts runs for a hover_measurement: build the create, send it under the per-claim key, then attach the variant. */
async function createAndAttach(fetchFn: typeof fetch, variant: unknown, logs: string[] = []): Promise<{ status: number; piId: string | null; attach: string | null }> {
  const metadata = { claim_id: CLAIM, type: "hover_measurement", variant }; // the client sends its variant inside metadata
  const form = buildStandardCreateForm({ amount: 1500, currency: "usd", description: "Complete Property Report", metadata });
  const res = await fetchFn(`${API}/payment_intents`, {
    method: "POST",
    headers: { Authorization: "Basic QUJD", "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": standardIdempotencyKey(metadata) },
    body: form.toString(),
  });
  if (!res.ok) return { status: res.status, piId: null, attach: null };
  const pi = await res.json();
  const attach = await attachVariantMetadata({ fetchFn, apiBase: API, basicAuth: "QUJD", paymentIntentId: pi.id, status: pi.status, variant, log: (m) => logs.push(m) });
  return { status: res.status, piId: pi.id, attach };
}

Deno.test("retrying the SAME claim with a DIFFERENT variant: no 400, the same PaymentIntent comes back, only the update differs", async () => {
  const { fetchFn, calls, intents } = fakeStripe();
  const first = await createAndAttach(fetchFn, "e"); // desktop, arm e
  const second = await createAndAttach(fetchFn, "unknown"); // phone, empty storage
  const third = await createAndAttach(fetchFn, "f"); // back through the Arm F link
  for (const r of [first, second, third]) assertEquals(r.status, 200, "no 400 on any retry");
  assertEquals(first.piId, second.piId);
  assertEquals(second.piId, third.piId);
  const creates = calls.filter((c) => c.url.endsWith("/payment_intents"));
  assertEquals(creates.length, 3);
  assertEquals(new Set(creates.map((c) => c.body)).size, 1, "the create body is identical on every attempt");
  assertEquals(new Set(creates.map((c) => c.key)).size, 1, "the idempotency key is identical on every attempt");
  const updates = calls.filter((c) => /\/payment_intents\/pi_\d+$/.test(c.url));
  assertEquals(updates.map((u) => new URLSearchParams(u.body).get("metadata[variant]")), ["e", "unknown", "f"], "only the update body differs");
  assertEquals(intents.get(first.piId!)!["metadata[variant]"], "f", "the latest variant, the one that confirms, is what Stripe holds when the webhook fires");
});

Deno.test("NEGATIVE CONTROL: put the variant inside the keyed create (the pre-fix code) and the same retry is refused with a 400", async () => {
  const { fetchFn } = fakeStripe();
  async function preFix(variant: string) {
    const metadata = { claim_id: CLAIM, type: "hover_measurement" };
    const form = buildStandardCreateForm({ amount: 1500, currency: "usd", description: "Complete Property Report", metadata });
    form.append("metadata[variant]", variant); // what #2110 did before this fix
    return await fetchFn(`${API}/payment_intents`, {
      method: "POST",
      headers: { Authorization: "Basic QUJD", "Idempotency-Key": standardIdempotencyKey(metadata) },
      body: form.toString(),
    });
  }
  assertEquals((await preFix("e")).status, 200);
  const retry = await preFix("unknown");
  assertEquals(retry.status, 400, "the fake Stripe does detect the defect: a reused key with a different body is refused");
  assertEquals((await retry.json()).error.type, "idempotency_error");
});

Deno.test("the deploy scenario: a claim whose PaymentIntent was created BEFORE this change (no variant) can still be retried after it", async () => {
  const { fetchFn } = fakeStripe();
  const metadata = { claim_id: CLAIM, type: "hover_measurement" };
  const old = buildStandardCreateForm({ amount: 1500, currency: "usd", description: "Complete Property Report", metadata });
  const headers = { Authorization: "Basic QUJD", "Idempotency-Key": standardIdempotencyKey(metadata) };
  const createdBefore = await fetchFn(`${API}/payment_intents`, { method: "POST", headers, body: old.toString() });
  assertEquals(createdBefore.status, 200);
  const after = await createAndAttach(fetchFn, "e"); // the first retry after the deploy
  assertEquals(after.status, 200, "no 400 for a claim that predates the change");
});

Deno.test("a failed or stalled update never changes the create's outcome (the buyer still gets the PaymentIntent)", async () => {
  const stripe = fakeStripe();
  const failing = ((url: string, init: RequestInit) => {
    if (/\/payment_intents\/pi_\d+$/.test(url)) return Promise.resolve(new Response("stripe says no, secret", { status: 500 }));
    return stripe.fetchFn(url, init);
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const r = await createAndAttach(failing, "e", logs);
  assertEquals(r.status, 200);
  assert(r.piId, "the PaymentIntent id is returned");
  assertEquals(r.attach, "failed");
  assert(!logs.join(" ").includes("secret"), "no Stripe text in the log");
});

Deno.test("N1: a STALLED update is cut off at its timeout, so it cannot hold the buyer's client_secret", async () => {
  // A stalled Stripe: never answers, and only gives up if the caller passed an abort signal.
  const stalled = ((_url: string, init: RequestInit) =>
    new Promise((_res, rej) => {
      const sig = init.signal as AbortSignal | undefined;
      if (sig) sig.addEventListener("abort", () => rej(new DOMException("aborted", "TimeoutError")));
      // no signal: this promise never settles
    })) as unknown as typeof fetch;
  const logs: string[] = [];
  const t0 = Date.now();
  const raced = await Promise.race([
    attachVariantMetadata({ fetchFn: stalled, apiBase: API, basicAuth: "QUJD", paymentIntentId: "pi_1", status: "requires_payment_method", variant: "e", timeoutMs: 30, log: (m) => logs.push(m) }),
    new Promise<string>((r) => setTimeout(() => r("HUNG"), 800)),
  ]);
  assertEquals(raced, "failed", "the attach returned (failed) instead of hanging");
  assert(Date.now() - t0 < 700, "returned promptly after the 30 ms timeout");
  assert(logs.length === 1 && logs[0].includes("payment unaffected") && !logs[0].includes("api.stripe.com"), logs.join("|"));
});

Deno.test("N1: the default timeout is a few seconds (bounded), not unbounded", async () => {
  const { ATTACH_TIMEOUT_MS } = await import("./variant-metadata.ts");
  assert(ATTACH_TIMEOUT_MS >= 1000 && ATTACH_TIMEOUT_MS <= 5000, String(ATTACH_TIMEOUT_MS));
});
