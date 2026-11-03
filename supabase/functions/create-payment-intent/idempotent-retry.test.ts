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
import {
  ALREADY_PAID_CODE,
  assertCreatedIntentNotPaid,
  checkClaimHasNotPaid,
  type HoverOrderRow,
  PAID_CHECK_UNAVAILABLE_CODE,
  refusalFor,
} from "./measurement-paid-gate.ts";

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
  return { fetchFn, calls, intents, byKey };
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

// ══ gh-3356: a claim that has already paid for its report gets no second chargeable PaymentIntent ═════════════════════════════
// The fake Stripe below adds what the gate reads: PaymentIntent SEARCH (eventually consistent: `searchLag` hides intents from it),
// PaymentIntent RETRIEVE, and Stripe's `Idempotent-Replayed: true` header on a replayed create. The hover_orders table is a plain array.
// `gatedSequence` is index.ts's hover_measurement standard flow with the REAL functions in index.ts's order (gate, keyed create, replay
// re-read, non-keyed update); `mainSequence` is main's flow (keyed create, non-keyed update) = the negative control.
const OTHER_CLAIM = "c0ffee00-0000-4000-8000-000000000002";

type SearchMode = "ok" | "http500" | "throw" | "badshape" | "has_more";
function paidWorld(opts: { basicAuth?: string } = {}) {
  const base = fakeStripe();
  const orders: HoverOrderRow[] = [];
  const state = { ordersError: null as unknown, searchMode: "ok" as SearchMode, searchLag: false, retrieveFails: false, gets: [] as { url: string; auth: string | null }[] };
  const seenKeys = new Set<string>();
  const json = (status: number, obj: unknown) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const view = (id: string) => {
    const rec = base.intents.get(id)!;
    return {
      id,
      status: rec["status"] ?? "requires_payment_method",
      amount: Number(rec["amount"]),
      metadata: { claim_id: rec["metadata[claim_id]"], type: rec["metadata[type]"] },
      latest_charge: { id: `ch_${id}`, refunded: rec["refunded"] === "true" },
    };
  };
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (String(init.method) === "GET") {
      state.gets.push({ url, auth: headers["Authorization"] ?? null });
      if (url.includes("/payment_intents/search")) {
        if (state.searchMode === "throw") throw new TypeError("network down");
        if (state.searchMode === "http500") return json(500, { error: { message: "boom secret" } });
        if (state.searchMode === "badshape") return json(200, { nope: true });
        const q = decodeURIComponent(new URL(url).searchParams.get("query") ?? "");
        const claim = q.match(/metadata\['claim_id'\]:'([^']+)'/)?.[1];
        const type = q.match(/metadata\['type'\]:'([^']+)'/)?.[1];
        const data = state.searchLag ? [] : [...base.intents.keys()].map(view).filter((p) => p.metadata.claim_id === claim && p.metadata.type === type);
        return json(200, { data, has_more: state.searchMode === "has_more" });
      }
      const m = url.match(/\/payment_intents\/(pi_\d+)\?/);
      if (m) {
        if (state.retrieveFails) return json(500, { error: {} });
        return base.intents.has(m[1]) ? json(200, view(m[1])) : json(404, { error: {} });
      }
    }
    if (String(init.method) === "POST" && url.endsWith("/payment_intents")) {
      const key = headers["Idempotency-Key"] ?? "";
      const had = seenKeys.has(key);
      seenKeys.add(key);
      const res = await base.fetchFn(url, init);
      if (had && res.ok) return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "Idempotent-Replayed": "true" } });
      return res;
    }
    return base.fetchFn(url, init);
  }) as unknown as typeof fetch;
  const basicAuth = opts.basicAuth ?? "QUJD";
  return {
    ...base, fetchFn, orders, state, basicAuth,
    /** Stripe's 24-hour idempotency window ends. */
    expireKeys() { base.byKey.clear(); seenKeys.clear(); },
    setStatus(piId: string, status: string) { base.intents.get(piId)!["status"] = status; },
    setRefunded(piId: string, v: "true" | "partial") { base.intents.get(piId)!["refunded"] = v; },
    createCalls: () => base.calls.filter((c) => c.method === "POST" && c.url.endsWith("/payment_intents")),
    updateCalls: () => base.calls.filter((c) => /\/payment_intents\/pi_\d+$/.test(c.url)),
  };
}
type World = ReturnType<typeof paidWorld>;
interface Answer { http: number; code?: string; piId: string | null; clientSecretReturned: boolean }

async function gatedSequence(w: World, claim = CLAIM, failOpen = false): Promise<Answer> {
  const metadata = { claim_id: claim, type: "hover_measurement", variant: "e" };
  const deps = {
    fetchFn: w.fetchFn, apiBase: API, basicAuth: w.basicAuth, claimId: claim, log: () => {},
    loadOrders: async () => ({ rows: w.state.ordersError ? null : w.orders, error: w.state.ordersError }),
  };
  const before = await checkClaimHasNotPaid(deps);
  const refusal = refusalFor(before);
  if (refusal && !(failOpen && before.kind === "unavailable")) return { http: refusal.status, code: refusal.body.code, piId: null, clientSecretReturned: false };
  const form = buildStandardCreateForm({ amount: 2263, currency: "usd", description: "Complete Property Report", metadata });
  const res = await w.fetchFn(`${API}/payment_intents`, {
    method: "POST",
    headers: { Authorization: `Basic ${w.basicAuth}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": standardIdempotencyKey(metadata, 2263) },
    body: form.toString(),
  });
  if (!res.ok) return { http: res.status, piId: null, clientSecretReturned: false };
  const pi = await res.clone().json();
  const replay = refusalFor(await assertCreatedIntentNotPaid(deps, pi, res));
  if (replay) return { http: replay.status, code: replay.body.code, piId: null, clientSecretReturned: false };
  await attachVariantMetadata({ fetchFn: w.fetchFn, apiBase: API, basicAuth: w.basicAuth, paymentIntentId: pi.id, status: pi.status, variant: "e", description: HOVER_MEASUREMENT_DESCRIPTION, log: () => {} });
  return { http: 200, piId: pi.id, clientSecretReturned: true };
}

/** main's flow: the keyed create then the non-keyed update, no look at orders or Stripe. */
async function mainSequence(w: World, claim = CLAIM): Promise<Answer> {
  const metadata = { claim_id: claim, type: "hover_measurement", variant: "e" };
  const form = buildStandardCreateForm({ amount: 2263, currency: "usd", description: "Complete Property Report", metadata });
  const res = await w.fetchFn(`${API}/payment_intents`, {
    method: "POST",
    headers: { Authorization: `Basic ${w.basicAuth}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": standardIdempotencyKey(metadata, 2263) },
    body: form.toString(),
  });
  if (!res.ok) return { http: res.status, piId: null, clientSecretReturned: false };
  const pi = await res.json();
  await attachVariantMetadata({ fetchFn: w.fetchFn, apiBase: API, basicAuth: w.basicAuth, paymentIntentId: pi.id, status: pi.status, variant: "e", description: HOVER_MEASUREMENT_DESCRIPTION, log: () => {} });
  return { http: 200, piId: pi.id, clientSecretReturned: true };
}

const orderFor = (piId: string | null, extra: Partial<HoverOrderRow> = {}): HoverOrderRow => ({ homeowner_stripe_payment_intent_id: piId, product_code: "roof_basic", rebate_paid_at: null, ...extra });

// ── 1. a paid claim, key expired (> 24 h): refused, nothing created ──────────────────────────────────────────────────────────
Deno.test("gh-3356 (1) PAID with NO order row (card succeeded, order step failed), key expired: refused 409, no second intent, no create call", async () => {
  const w = paidWorld();
  const first = await gatedSequence(w);
  assertEquals(first.http, 200);
  w.setStatus(first.piId!, "succeeded"); // the card succeeded; create-measurement-order never recorded it
  w.expireKeys();
  const createsBefore = w.createCalls().length;
  const again = await gatedSequence(w);
  assertEquals([again.http, again.code, again.clientSecretReturned], [409, ALREADY_PAID_CODE, false]);
  assertEquals(w.intents.size, 1, "no second PaymentIntent exists");
  assertEquals(w.createCalls().length, createsBefore, "the create was never sent");
});

Deno.test("NEGATIVE CONTROL (1): main's flow on the same state mints a SECOND chargeable intent", async () => {
  const w = paidWorld();
  const first = await mainSequence(w);
  w.setStatus(first.piId!, "succeeded");
  w.expireKeys();
  const again = await mainSequence(w);
  assertEquals([again.http, again.clientSecretReturned], [200, true]);
  assertEquals(w.intents.size, 2, "two PaymentIntents for one claim: the defect");
  assert(again.piId !== first.piId);
});

Deno.test("gh-3356 (1b) paid WITH an order row: refused; and when Stripe search lags the order's own PaymentIntent is read directly", async () => {
  for (const lag of [false, true]) {
    const w = paidWorld();
    const first = await gatedSequence(w);
    w.setStatus(first.piId!, "succeeded");
    w.orders.push(orderFor(first.piId));
    w.state.searchLag = lag;
    w.expireKeys();
    const again = await gatedSequence(w);
    assertEquals([again.http, again.code], [409, ALREADY_PAID_CODE], `searchLag=${lag}`);
    assertEquals(w.intents.size, 1);
  }
});

Deno.test("gh-3356 (1c) a REBATED order (rebate_paid_at set) counts as paid and needs no Stripe call; the refund of the rebate does not reopen the claim", async () => {
  const w = paidWorld();
  const first = await gatedSequence(w);
  w.setStatus(first.piId!, "succeeded");
  w.setRefunded(first.piId!, "true"); // process-hover-rebate refunded it
  w.orders.push(orderFor(first.piId, { rebate_paid_at: "2026-11-01T00:00:00Z" }));
  w.expireKeys();
  w.state.gets.length = 0;
  const again = await gatedSequence(w);
  assertEquals([again.http, again.code], [409, ALREADY_PAID_CODE]);
  assertEquals(w.state.gets.length, 0, "decided from the order row alone");
  assertEquals(w.intents.size, 1);
});

// ── 2. claims that must still be able to buy ─────────────────────────────────────────────────────────────────────────────────
Deno.test("gh-3356 (2) a first purchase proceeds; an unpaid intent retried inside 24 h returns the SAME intent; after expiry a fresh one is allowed", async () => {
  const w = paidWorld();
  const a = await gatedSequence(w);
  const b = await gatedSequence(w); // reload, key live, intent unpaid
  assertEquals([a.http, b.http], [200, 200]);
  assertEquals(a.piId, b.piId);
  assertEquals(w.intents.size, 1);
  w.expireKeys();
  const c = await gatedSequence(w); // unpaid intent abandoned for > 24 h: today's behaviour kept
  assertEquals(c.http, 200);
  assertEquals(w.intents.size, 2);
  assertEquals(w.createCalls().length, 3);
});

Deno.test("gh-3356 (2b) canceled, failed (requires_payment_method) and requires_action intents do not block a purchase", async () => {
  for (const status of ["canceled", "requires_payment_method", "requires_action", "requires_confirmation"]) {
    const w = paidWorld();
    const first = await gatedSequence(w);
    w.setStatus(first.piId!, status);
    w.expireKeys();
    const again = await gatedSequence(w);
    assertEquals(again.http, 200, status);
  }
});

Deno.test("gh-3356 (2c) refunds: a fully refunded payment with no rebate keeps today's behaviour (not blocked); a partial refund and an in-flight payment ARE blocked", async () => {
  const wFull = paidWorld();
  const f = await gatedSequence(wFull);
  wFull.setStatus(f.piId!, "succeeded"); wFull.setRefunded(f.piId!, "true"); wFull.expireKeys();
  assertEquals((await gatedSequence(wFull)).http, 200, "support-refunded in full, no rebate: repurchase allowed as today (FLAGGED in the PR)");
  const wPartial = paidWorld();
  const p = await gatedSequence(wPartial);
  wPartial.setStatus(p.piId!, "succeeded"); wPartial.setRefunded(p.piId!, "partial"); wPartial.expireKeys();
  assertEquals((await gatedSequence(wPartial)).code, ALREADY_PAID_CODE);
  const wFlight = paidWorld();
  const q = await gatedSequence(wFlight);
  wFlight.setStatus(q.piId!, "processing"); wFlight.expireKeys();
  assertEquals((await gatedSequence(wFlight)).code, ALREADY_PAID_CODE);
});

Deno.test("gh-3356 (2d) another claim's payment, and a contractor's detailed-upgrade order on this claim, do not block this claim", async () => {
  const w = paidWorld();
  const other = await gatedSequence(w, OTHER_CLAIM);
  w.setStatus(other.piId!, "succeeded");
  w.orders.push(orderFor("pi_999", { product_code: "roof_upgrade_detailed" })); // a contractor's order on THIS claim, different product
  w.orders.push(orderFor(null, { product_code: "roof_basic" })); // a quote-only row with no payment
  const mine = await gatedSequence(w, CLAIM);
  assertEquals(mine.http, 200);
});

Deno.test("gh-3356 (2e) the lookups use the SAME Stripe key as the create (a test claim is checked against test-mode data)", async () => {
  const w = paidWorld({ basicAuth: "VEVTVC1LRVk6" });
  await gatedSequence(w);
  assert(w.state.gets.length >= 1);
  for (const g of w.state.gets) assertEquals(g.auth, "Basic VEVTVC1LRVk6");
});

// ── 3. paid claim INSIDE the 24-hour window ──────────────────────────────────────────────────────────────────────────────────
Deno.test("gh-3356 (3) paid claim within 24 h, search sees it: refused BEFORE the create, no second intent", async () => {
  const w = paidWorld();
  const first = await gatedSequence(w);
  w.setStatus(first.piId!, "succeeded");
  const createsBefore = w.createCalls().length;
  const again = await gatedSequence(w); // key still live
  assertEquals([again.http, again.code, again.clientSecretReturned], [409, ALREADY_PAID_CODE, false]);
  assertEquals(w.createCalls().length, createsBefore);
  assertEquals(w.intents.size, 1);
});

Deno.test("gh-3356 (3b) paid within 24 h while Stripe search has not indexed it yet: the replayed (stale) intent is re-read and its secret is NOT handed back", async () => {
  const w = paidWorld();
  const first = await gatedSequence(w);
  w.setStatus(first.piId!, "succeeded");
  w.state.searchLag = true;
  const updatesBefore = w.updateCalls().length;
  const again = await gatedSequence(w);
  assertEquals([again.http, again.code, again.clientSecretReturned], [409, ALREADY_PAID_CODE, false]);
  assertEquals(w.intents.size, 1, "the keyed create replayed the first intent; no second intent was made");
  assertEquals(w.updateCalls().length, updatesBefore, "no description or variant update was sent for the refused request");
});

Deno.test("NEGATIVE CONTROL (3b): main's flow hands the paid claim's replayed intent back as if it were payable", async () => {
  const w = paidWorld();
  const first = await mainSequence(w);
  w.setStatus(first.piId!, "succeeded");
  const again = await mainSequence(w);
  assertEquals([again.http, again.piId, again.clientSecretReturned], [200, first.piId, true]);
});

Deno.test("gh-3356 (3c) the replay re-read happens only when the create looks like a replay (a first-time buyer pays no extra Stripe call)", async () => {
  const w = paidWorld();
  const metadata = { claim_id: CLAIM, type: "hover_measurement" };
  const res = await w.fetchFn(`${API}/payment_intents`, { method: "POST", headers: { "Idempotency-Key": standardIdempotencyKey(metadata, 2263) }, body: buildStandardCreateForm({ amount: 2263, currency: "usd", description: "x", metadata }).toString() });
  const pi = await res.clone().json();
  const deps = { fetchFn: w.fetchFn, apiBase: API, basicAuth: "QUJD", log: () => {} };
  w.state.gets.length = 0;
  assertEquals((await assertCreatedIntentNotPaid(deps, { ...pi, created: 1_000_000 }, res, 1_000_010)).kind, "not_paid");
  assertEquals(w.state.gets.length, 0, "fresh and not replayed: no re-read");
  w.setStatus(pi.id, "succeeded");
  assertEquals((await assertCreatedIntentNotPaid(deps, { ...pi, created: 1_000_000 }, res, 1_000_000 + 3600)).kind, "paid");
  assertEquals(w.state.gets.length, 1, "an hour old, no header: re-read, and it is paid");
});

// ── 4. a Stripe or database lookup failure fails CLOSED with a retry code ────────────────────────────────────────────────────
Deno.test("gh-3356 (4) every lookup failure (search 500, network, bad shape, more than a page, orders read error, retrieve 500) refuses with the retry code and creates nothing", async () => {
  const cases: [string, (w: World) => void][] = [
    ["search http 500", (w) => { w.state.searchMode = "http500"; }],
    ["search network error", (w) => { w.state.searchMode = "throw"; }],
    ["search answer not understood", (w) => { w.state.searchMode = "badshape"; }],
    ["search has_more", (w) => { w.state.searchMode = "has_more"; }],
    ["orders read error", (w) => { w.state.ordersError = { message: "db down" }; }],
    ["order PaymentIntent retrieve 500", (w) => { w.orders.push(orderFor("pi_77")); w.state.searchLag = true; w.state.retrieveFails = true; }],
  ];
  for (const [label, arm] of cases) {
    const w = paidWorld();
    arm(w);
    const r = await gatedSequence(w);
    assertEquals([r.http, r.code, r.clientSecretReturned], [503, PAID_CHECK_UNAVAILABLE_CODE, false], label);
    assertEquals(w.createCalls().length, 0, `${label}: nothing created`);
  }
});

Deno.test("gh-3356 (4b) the replay re-read failing also refuses with the retry code (the buyer is not handed an unchecked secret)", async () => {
  const w = paidWorld();
  await gatedSequence(w); // first intent
  w.state.retrieveFails = true;
  const again = await gatedSequence(w); // replay -> re-read fails
  assertEquals([again.http, again.code], [503, PAID_CHECK_UNAVAILABLE_CODE]);
});

Deno.test("NEGATIVE CONTROL (4): FAILING OPEN on a lookup error lets a paid claim be charged twice while Stripe search is down", async () => {
  const w = paidWorld();
  const first = await gatedSequence(w);
  w.setStatus(first.piId!, "succeeded");
  w.expireKeys();
  w.state.searchMode = "http500";
  const open = await gatedSequence(w, CLAIM, true);
  assertEquals(open.http, 200);
  assertEquals(w.intents.size, 2, "fail-open created the second chargeable intent; the shipped gate does not (case 4)");
});

Deno.test("gh-3356 (4c) a failed lookup never puts Stripe's text or a URL in the log", async () => {
  const logs: string[] = [];
  const w = paidWorld();
  w.state.searchMode = "throw";
  await checkClaimHasNotPaid({ fetchFn: w.fetchFn, apiBase: API, basicAuth: "QUJD", claimId: CLAIM, loadOrders: async () => ({ rows: [], error: null }), log: (m) => logs.push(m) });
  assert(logs.length === 1 && !logs[0].includes("network down") && !logs[0].includes("api.stripe.com"), logs.join("|"));
});

// ── 5. the key and the keyed create body are untouched ───────────────────────────────────────────────────────────────────────
Deno.test("gh-3356 (5) the gated flow sends the SAME key and the SAME create body as main's, so a paid claim's reload inside 24 h still gets the same intent", async () => {
  const g = paidWorld(); const m = paidWorld();
  await gatedSequence(g); await mainSequence(m);
  const gc = g.createCalls()[0]; const mc = m.createCalls()[0];
  assertEquals(gc.key, mc.key);
  assertEquals(gc.body, mc.body);
  assertEquals(gc.key, `hover_measurement-${CLAIM}-2263`);
});

// ── 6. index.ts wiring (structural, as the B1 tests do for the create) ───────────────────────────────────────────────────────
// GH3356_INDEX_SRC points the structural checks at another copy of index.ts (the PR body runs them against main's, to show they fail there).
// CI runs without --allow-env, so reading it is allowed to fail.
let indexSrcOverride: string | undefined;
try { indexSrcOverride = Deno.env.get("GH3356_INDEX_SRC"); } catch { /* no env permission: use the real file */ }
const indexSource = await Deno.readTextFile(indexSrcOverride ?? new URL("./index.ts", import.meta.url).pathname);
Deno.test("gh-3356 (6) index.ts: the paid-claim check runs before the keyed create, the replay re-read after it and before the update, only for hover_measurement", () => {
  const iGate = indexSource.indexOf("await checkClaimHasNotPaid(");
  const iBuild = indexSource.indexOf("buildStandardCreateForm({ amount, currency, description, metadata, contractor_id })");
  const iCreate = indexSource.indexOf("fetchStripeWithTimeout(fetch, `${STRIPE_API_BASE}/payment_intents`");
  const iReplay = indexSource.indexOf("await assertCreatedIntentNotPaid(");
  const iAttach = indexSource.indexOf("await attachVariantMetadata(");
  assert(iGate > -1, "index.ts calls checkClaimHasNotPaid");
  assert(iGate < iBuild && iBuild < iCreate, "the check precedes the create form and the create");
  assert(iReplay > iCreate && iReplay < iAttach, "the replay re-read follows the create and precedes the variant/description update");
  assert(/if \(metadata\.type === "hover_measurement"\) \{\s*const paidVerdict = await checkClaimHasNotPaid\(/.test(indexSource), "gated on hover_measurement");
  assert(indexSource.includes("const idempotencyKey = standardIdempotencyKey(metadata, amount);"), "the key is still standardIdempotencyKey(metadata, amount)");
  assert(indexSource.includes('"Idempotency-Key": idempotencyKey,'), "the create still sends exactly that key");
});

Deno.test("gh-3356 (6b) index.ts: a refusal returns the verdict's own status and body, not a 200 with a secret", () => {
  assert(indexSource.includes("refusalFor(paidVerdict)") && indexSource.includes("refusalFor(replayVerdict)"));
  assert(/paidRefusal\.status/.test(indexSource) && /replayRefusal\.status/.test(indexSource));
});

Deno.test("gh-3356 refusalFor: not_paid is no refusal; paid is a 409 with a code; unavailable is a 503 with a different code", () => {
  assertEquals(refusalFor({ kind: "not_paid" }), null);
  assertEquals(refusalFor({ kind: "paid", reason: "succeeded", paymentIntentId: "pi_1", hasOrderRow: false })!.status, 409);
  assertEquals(refusalFor({ kind: "unavailable", why: "x" })!.status, 503);
  assertEquals(new Set<string>([ALREADY_PAID_CODE, PAID_CHECK_UNAVAILABLE_CODE]).size, 2);
});
