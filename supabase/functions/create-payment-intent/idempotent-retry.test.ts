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
import { HOVER_MEASUREMENT_DESCRIPTION } from "./standard-create-form.ts";

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
async function createAndAttach(fetchFn: typeof fetch, variant: unknown, logs: string[] = [], optOut = false): Promise<{ status: number; piId: string | null; attach: string | null }> {
  const metadata = { claim_id: CLAIM, type: "hover_measurement", variant }; // the client sends its variant inside metadata
  const form = buildStandardCreateForm({ amount: 1500, currency: "usd", description: "Complete Property Report", metadata });
  const res = await fetchFn(`${API}/payment_intents`, {
    method: "POST",
    headers: { Authorization: "Basic QUJD", "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": standardIdempotencyKey(metadata, 1500) },
    body: form.toString(),
  });
  if (!res.ok) return { status: res.status, piId: null, attach: null };
  const pi = await res.json();
  const attach = await attachVariantMetadata({ fetchFn, apiBase: API, basicAuth: "QUJD", paymentIntentId: pi.id, status: pi.status, variant, optOut, log: (m) => logs.push(m) });
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
      headers: { Authorization: "Basic QUJD", "Idempotency-Key": standardIdempotencyKey(metadata, 1500) },
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
  const headers = { Authorization: "Basic QUJD", "Idempotency-Key": standardIdempotencyKey(metadata, 1500) };
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

Deno.test("F2 (#2134): retrying the same claim with the GPC signal on one attempt and off on another: still no 400, and the signal reaches Stripe only via the update", async () => {
  const { fetchFn, calls, intents } = fakeStripe();
  const a = await createAndAttach(fetchFn, "e", [], false); // first visit, GPC off
  const b = await createAndAttach(fetchFn, "e", [], true); // retry from a GPC browser
  const c = await createAndAttach(fetchFn, "unknown", [], false); // a later retry without the signal
  for (const r of [a, b, c]) assertEquals(r.status, 200, "no 400");
  assertEquals(a.piId, b.piId);
  const creates = calls.filter((x) => x.url.endsWith("/payment_intents"));
  assertEquals(new Set(creates.map((x) => x.body)).size, 1, "the create body is identical whatever the signal");
  assert(!creates.some((x) => x.body.includes("ad_sharing_opt_out")), "the signal is never a create parameter");
  assertEquals(intents.get(a.piId!)!["metadata[ad_sharing_opt_out]"], "1", "and once seen it is on the PaymentIntent (an update never removes it)");
});

// ── gh-3350: the description rename must not change the key or the keyed create body ─────────────────────────────────────────
// For a claim that has ALREADY PAID, the create's Idempotency-Key is the only thing that returns the same (succeeded)
// PaymentIntent on a reload, so a reload after the deploy, and again after the clients publish, must get that same intent back.
// `serverCreate` is index.ts's hover_measurement sequence: keyed create, then the non-keyed update (variant + description).
// (standardIdempotencyKey is called through a loose signature so this same test can be run against a build whose key takes the
// client description as a third argument, to show that build fails it.)
async function serverCreate(fetchFn: typeof fetch, clientDescription: string, claim = CLAIM): Promise<{ status: number; piId: string | null }> {
  const metadata = { claim_id: claim, type: "hover_measurement" };
  const form = buildStandardCreateForm({ amount: 2263, currency: "usd", description: clientDescription, metadata });
  const key = (standardIdempotencyKey as (...a: unknown[]) => string)(metadata, 2263, clientDescription);
  const res = await fetchFn(`${API}/payment_intents`, {
    method: "POST",
    headers: { Authorization: "Basic QUJD", "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": key },
    body: form.toString(),
  });
  if (!res.ok) return { status: res.status, piId: null };
  const pi = await res.json();
  await attachVariantMetadata({ fetchFn, apiBase: API, basicAuth: "QUJD", paymentIntentId: pi.id, status: pi.status, variant: "e", description: HOVER_MEASUREMENT_DESCRIPTION, log: () => {} });
  return { status: 200, piId: pi.id };
}

Deno.test("gh-3350: a claim that already PAID gets the SAME succeeded intent back on a reload after the deploy and again after the clients publish (no second chargeable intent)", async () => {
  const { fetchFn, calls, intents } = fakeStripe();
  const before = await serverCreate(fetchFn, "Complete Property Report"); // main, old page: the intent that gets paid
  intents.get(before.piId!)!["status"] = "succeeded"; // the homeowner paid
  const afterServerDeploy = await serverCreate(fetchFn, "Complete Property Report"); // old cached page, new function
  const afterClientsPublish = await serverCreate(fetchFn, "Aerial Roof Report"); // new page, new function
  for (const r of [before, afterServerDeploy, afterClientsPublish]) assertEquals(r.status, 200, "no 400 at any step");
  assertEquals(afterServerDeploy.piId, before.piId);
  assertEquals(afterClientsPublish.piId, before.piId);
  assertEquals(intents.size, 1, "exactly one PaymentIntent exists for the claim: no second chargeable intent was created");
  const creates = calls.filter((c) => c.url.endsWith("/payment_intents"));
  assertEquals(new Set(creates.map((c) => c.key)).size, 1, "one idempotency key throughout");
  assertEquals(new Set(creates.map((c) => c.body)).size, 1, "one create body throughout");
  assertEquals(intents.get(before.piId!)!["description"], "Aerial Roof Report", "the visible name is set by the update");
});

Deno.test("gh-3350: a new-page first visit gets the old description in the keyed create and the new one from the update", async () => {
  const { fetchFn, calls, intents } = fakeStripe();
  const r = await serverCreate(fetchFn, "Aerial Roof Report");
  const create = calls.find((c) => c.url.endsWith("/payment_intents"))!;
  assertEquals(new URLSearchParams(create.body).get("description"), "Complete Property Report");
  const update = calls.find((c) => /\/payment_intents\/pi_\d+$/.test(c.url))!;
  assertEquals(new URLSearchParams(update.body).get("description"), "Aerial Roof Report");
  assertEquals(intents.get(r.piId!)!["description"], "Aerial Roof Report");
});

Deno.test("gh-3350: a failed, refused or stalled description update never fails the charge, and the intent keeps its create-time description", async () => {
  for (const mode of ["500", "400-on-succeeded", "stall"]) {
    const stripe = fakeStripe();
    const wrapped = ((url: string, init: RequestInit) => {
      if (/\/payment_intents\/pi_\d+$/.test(url)) {
        if (mode === "500") return Promise.resolve(new Response("stripe says no", { status: 500 }));
        if (mode === "400-on-succeeded") return Promise.resolve(new Response(JSON.stringify({ error: { message: "cannot update a succeeded PaymentIntent" } }), { status: 400 }));
        return new Promise((_res, rej) => { (init.signal as AbortSignal).addEventListener("abort", () => rej(new DOMException("aborted", "TimeoutError"))); });
      }
      return stripe.fetchFn(url, init);
    }) as unknown as typeof fetch;
    const metadata = { claim_id: CLAIM, type: "hover_measurement" };
    const res = await wrapped(`${API}/payment_intents`, { method: "POST", headers: { "Idempotency-Key": standardIdempotencyKey(metadata, 2263) }, body: buildStandardCreateForm({ amount: 2263, currency: "usd", description: "x", metadata }).toString() });
    const pi = await (res as Response).json();
    const logs: string[] = [];
    const out = await attachVariantMetadata({ fetchFn: wrapped, apiBase: API, basicAuth: "QUJD", paymentIntentId: pi.id, status: "requires_payment_method", variant: "e", description: HOVER_MEASUREMENT_DESCRIPTION, timeoutMs: 30, log: (m) => logs.push(m) });
    assertEquals(out, "failed", mode);
    assert(logs.length === 1 && !logs[0].includes("stripe says no") && !logs[0].includes("cannot update"), mode);
    assertEquals(stripe.intents.get(pi.id)!["description"], "Complete Property Report", mode);
  }
});

Deno.test("gh-3350: on a replayed intent the create reports as not yet paid (first response), the update is still sent, and it changes nothing but description and variant", async () => {
  const { fetchFn, calls, intents } = fakeStripe();
  const first = await serverCreate(fetchFn, "Complete Property Report");
  intents.get(first.piId!)!["status"] = "succeeded";
  const amountBefore = intents.get(first.piId!)!["amount"];
  await serverCreate(fetchFn, "Aerial Roof Report");
  const updates = calls.filter((c) => /\/payment_intents\/pi_\d+$/.test(c.url));
  assertEquals(updates.length, 2, "the replay's stale status means the update is sent again");
  for (const u of updates) assertEquals([...new URLSearchParams(u.body).keys()].sort(), ["description", "metadata[variant]"]);
  assertEquals(intents.get(first.piId!)!["status"], "succeeded");
  assertEquals(intents.get(first.piId!)!["amount"], amountBefore);
});
