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
  cancelSupersededIntents,
  checkClaimHasNotPaid,
  alertKindFor,
  CANCELLED_REPLAY_CODE,
  evaluatePaymentIntent,
  supersededPaidVerdict,
  HOVER_ORDER_SELECT,
  type HoverOrderRow,
  loadHoverOrders,
  MAX_CANCELS,
  PAID_CHECK_UNAVAILABLE_CODE,
  refusalFor,
} from "./measurement-paid-gate.ts";
import { fakeSupabase, type Row, tableColumns } from "./paid-gate-test-support.ts";
import { fetchStripeWithTimeout } from "./stripe-fetch.ts";

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
// RETRIEVE, CANCEL, and Stripe's `Idempotent-Replayed: true` header on a replayed create. It is STRICT like Stripe: it answers 400 to a
// search query it does not support or an `expand` it does not know, 401 to any request that does not carry the expected key, and returns
// `latest_charge` as a bare id (not an object) unless the request expanded it, so a missing expand shows up as a refund that cannot be read.
// hover_orders and platform_alerts_log are fakeSupabase tables whose columns come from the migrations. `gatedSequence` is index.ts's
// hover_measurement standard flow with the REAL functions in index.ts's order (gate, keyed create, replay re-read, cancel of older unpaid
// intents, non-keyed update); `mainSequence` is main's flow (keyed create, non-keyed update) = the negative control.
const OTHER_CLAIM = "c0ffee00-0000-4000-8000-000000000002";
const SCHEMA = { hover_orders: await tableColumns("hover_orders"), platform_alerts_log: await tableColumns("platform_alerts_log") };

type SearchMode = "ok" | "http500" | "throw" | "badshape" | "has_more" | "stall_body";
type CancelMode = "ok" | "http500" | "throw" | "confirm_wins" | "processing_wins";
function paidWorld(opts: { basicAuth?: string } = {}) {
  const base = fakeStripe();
  const basicAuth = opts.basicAuth ?? "QUJD";
  const orders: Row[] = [];
  const alerts: Row[] = [];
  const state = {
    ordersError: null as unknown, searchMode: "ok" as SearchMode, searchLag: false, retrieveFails: false, cancelMode: "ok" as CancelMode,
    /** how old (seconds) the expanded latest_charge is (a test seam: the gate no longer looks at it, there is no grace period) */
    chargeAgeSeconds: 86400,
    /** intents the search returns whatever the query says (a search that over-matches) */
    searchInjected: [] as string[],
    /** what search REPORTS for an intent, overriding its real status (a stale index) */
    staleSearch: {} as Record<string, string>,
    gets: [] as { url: string; auth: string | null }[],
    cancels: [] as string[],
  };
  const seenKeys = new Set<string>();
  const json = (status: number, obj: unknown) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const strictExpand = (u: URL, allowed: string): string[] | Response => {
    const ex = u.searchParams.getAll("expand[]");
    if (ex.some((e) => e !== allowed)) return json(400, { error: { type: "invalid_request_error", message: `This property cannot be expanded (${ex.join(",")}).` } });
    return ex;
  };
  const view = (id: string, expanded: boolean, reportedStatus?: string) => {
    const rec = base.intents.get(id)!;
    return {
      id,
      status: reportedStatus ?? rec["status"] ?? "requires_payment_method",
      amount: Number(rec["amount"]),
      metadata: { claim_id: rec["metadata[claim_id]"], type: rec["metadata[type]"] },
      latest_charge: expanded ? { id: `ch_${id}`, refunded: rec["refunded"] === "true", created: Math.floor(Date.now() / 1000) - state.chargeAgeSeconds } : `ch_${id}`,
    };
  };
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (headers["Authorization"] !== `Basic ${basicAuth}`) return json(401, { error: { type: "invalid_request_error", message: "Invalid API Key provided" } });
    if (String(init.method) === "GET") {
      state.gets.push({ url, auth: headers["Authorization"] ?? null });
      const u = new URL(url);
      if (u.pathname.endsWith("/payment_intents/search")) {
        if (state.searchMode === "throw") throw new TypeError("network down");
        if (state.searchMode === "http500") return json(500, { error: { message: "boom secret" } });
        if (state.searchMode === "badshape") return json(200, { nope: true });
        for (const k of u.searchParams.keys()) if (!["query", "limit", "expand[]"].includes(k)) return json(400, { error: { message: `Received unknown parameter: ${k}` } });
        const lim = Number(u.searchParams.get("limit") ?? "10");
        if (!(lim >= 1 && lim <= 100)) return json(400, { error: { message: "Invalid limit" } });
        const q = u.searchParams.get("query") ?? "";
        const m = q.match(/^metadata\['claim_id'\]:'([A-Za-z0-9-]+)' AND metadata\['type'\]:'hover_measurement'$/);
        if (!m) return json(400, { error: { type: "invalid_request_error", message: `Invalid search query: ${q}` } });
        const ex = strictExpand(u, "data.latest_charge");
        if (ex instanceof Response) return ex;
        const expanded = ex.includes("data.latest_charge");
        const matching = state.searchLag ? [] : [...base.intents.keys()].map((id) => view(id, expanded, state.staleSearch[id])).filter((p) => p.metadata.claim_id === m[1] && p.metadata.type === "hover_measurement");
        const data = [...matching, ...state.searchInjected.filter((id) => !matching.some((p) => p.id === id)).map((id) => view(id, expanded, state.staleSearch[id]))];
        if (state.searchMode === "stall_body") {
          // headers arrive, then the body never completes unless the caller aborts (like a real stalled socket)
          const body = new ReadableStream({ start(c) { (init.signal as AbortSignal | undefined)?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError"))); } });
          return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
        }
        return json(200, { object: "search_result", data, has_more: state.searchMode === "has_more" });
      }
      const m = u.pathname.match(/\/payment_intents\/(pi_[A-Za-z0-9_]+)$/);
      if (m) {
        if (state.retrieveFails) return json(500, { error: {} });
        const ex = strictExpand(u, "latest_charge");
        if (ex instanceof Response) return ex;
        return base.intents.has(m[1]) ? json(200, view(m[1], ex.includes("latest_charge"))) : json(404, { error: { code: "resource_missing", message: "No such payment_intent" } });
      }
      return json(404, { error: { message: "unknown route" } });
    }
    const cm = new URL(url).pathname.match(/\/payment_intents\/(pi_\d+)\/cancel$/);
    if (String(init.method) === "POST" && cm) {
      state.cancels.push(cm[1]);
      if (state.cancelMode === "throw") throw new TypeError("network down");
      if (state.cancelMode === "http500") return json(500, { error: { message: "boom" } });
      const rec = base.intents.get(cm[1]);
      if (!rec) return json(404, { error: { code: "resource_missing" } });
      if (state.cancelMode === "confirm_wins") rec["status"] = "succeeded"; // the other tab's confirm lands first
      if (state.cancelMode === "processing_wins") rec["status"] = "processing"; // ... or its confirm is still in flight (a bank debit, say)
      const st = rec["status"] ?? "requires_payment_method";
      if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(st)) { rec["status"] = "canceled"; return json(200, { id: cm[1], status: "canceled" }); }
      return json(400, { error: { type: "invalid_request_error", code: "payment_intent_unexpected_state", payment_intent: { id: cm[1], status: st } } });
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
  return {
    ...base, fetchFn, orders, alerts, state, basicAuth,
    sb: () => fakeSupabase(SCHEMA, { hover_orders: orders, platform_alerts_log: alerts }, { selectError: state.ordersError ? { hover_orders: state.ordersError } : {} }),
    /** Stripe removes the idempotency keys (the time is not fixed; a test just clears them). */
    expireKeys() { base.byKey.clear(); seenKeys.clear(); },
    setStatus(piId: string, status: string) { base.intents.get(piId)!["status"] = status; },
    statusOf: (piId: string) => base.intents.get(piId)!["status"] ?? "requires_payment_method",
    setRefunded(piId: string, v: "true" | "partial") { base.intents.get(piId)!["refunded"] = v; },
    createCalls: () => base.calls.filter((c) => c.method === "POST" && c.url.endsWith("/payment_intents")),
    updateCalls: () => base.calls.filter((c) => /\/payment_intents\/pi_\d+$/.test(c.url)),
  };
}
type World = ReturnType<typeof paidWorld>;
interface Answer { http: number; code?: string; piId: string | null; clientSecretReturned: boolean; cancelled?: string[] }

async function gatedSequence(w: World, claim = CLAIM, o: { failOpen?: boolean; cancel?: boolean; amount?: number; deps?: Partial<Parameters<typeof checkClaimHasNotPaid>[0]> } = {}): Promise<Answer> {
  const metadata = { claim_id: claim, type: "hover_measurement", variant: "e" };
  const sb = w.sb();
  const deps = {
    fetchFn: w.fetchFn, apiBase: API, basicAuth: w.basicAuth, claimId: claim, log: () => {},
    loadOrders: () => loadHoverOrders(sb, claim),
    ...(o.deps ?? {}),
  };
  const before = await checkClaimHasNotPaid(deps);
  const refusal = refusalFor(before);
  if (refusal && !(o.failOpen && before.kind === "unavailable")) return { http: refusal.status, code: refusal.body.code, piId: null, clientSecretReturned: false };
  const candidates = before.kind === "not_paid" ? before.cancelable ?? [] : [];
  const form = buildStandardCreateForm({ amount: o.amount ?? 2263, currency: "usd", description: "Complete Property Report", metadata });
  const res = await w.fetchFn(`${API}/payment_intents`, {
    method: "POST",
    headers: { Authorization: `Basic ${w.basicAuth}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": standardIdempotencyKey(metadata, o.amount ?? 2263) },
    body: form.toString(),
  });
  if (!res.ok) return { http: res.status, piId: null, clientSecretReturned: false };
  const pi = await res.clone().json();
  const replay = refusalFor(await assertCreatedIntentNotPaid(deps, pi, res));
  if (replay) return { http: replay.status, code: replay.body.code, piId: null, clientSecretReturned: false };
  let cancelled: string[] = [];
  if (o.cancel !== false) {
    const sup = await cancelSupersededIntents(deps, candidates, pi.id);
    if (sup.paid) return { http: 409, code: ALREADY_PAID_CODE, piId: null, clientSecretReturned: false };
    cancelled = sup.cancelled;
  }
  await attachVariantMetadata({ fetchFn: w.fetchFn, apiBase: API, basicAuth: w.basicAuth, paymentIntentId: pi.id, status: pi.status, variant: "e", description: HOVER_MEASUREMENT_DESCRIPTION, log: () => {} });
  return { http: 200, piId: pi.id, clientSecretReturned: true, cancelled };
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

const orderFor = (piId: string | null, extra: Row = {}, claim = CLAIM): Row => ({ claim_id: claim, homeowner_stripe_payment_intent_id: piId, product_code: "roof_basic", rebate_paid_at: null, ...extra });

// ── 1. a paid claim, key expired: refused, nothing created ──────────────────────────────────────────────────────────
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

Deno.test("gh-3356 (1d) an order row naming a PaymentIntent Stripe has never heard of (404) is PAID, never a permanent 503", async () => {
  const w = paidWorld();
  w.orders.push(orderFor("pi_ghost_from_another_mode"));
  const r = await gatedSequence(w);
  assertEquals([r.http, r.code], [409, ALREADY_PAID_CODE]);
  assertEquals(w.createCalls().length, 0);
  // and any other failure to read that order's intent is still the retry answer, not paid
  const w2 = paidWorld();
  w2.orders.push(orderFor("pi_ghost_from_another_mode"));
  w2.state.retrieveFails = true;
  assertEquals((await gatedSequence(w2)).code, PAID_CHECK_UNAVAILABLE_CODE);
});

// ── 2. claims that must still be able to buy ─────────────────────────────────────────────────────────────────────────────────
Deno.test("gh-3356 (2) a first purchase proceeds; an unpaid intent retried while the key is held returns the SAME intent; after expiry a fresh one is allowed", async () => {
  const w = paidWorld();
  const a = await gatedSequence(w);
  const b = await gatedSequence(w); // reload, key live, intent unpaid
  assertEquals([a.http, b.http], [200, 200]);
  assertEquals(a.piId, b.piId);
  assertEquals(w.intents.size, 1);
  assertEquals(w.state.cancels.length, 0, "the intent being handed back is never cancelled");
  w.expireKeys();
  const c = await gatedSequence(w); // unpaid intent abandoned until the key is gone: a fresh one is allowed, the old one is superseded
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

Deno.test("gh-3356 (2c) refunds: a fully refunded payment with no rebate STILL BLOCKS self-repurchase (D-413 annotation 2026-11-05, 409 already-paid, no alert); a partial refund and an in-flight payment ARE blocked too", async () => {
  const wFull = paidWorld();
  const f = await gatedSequence(wFull);
  wFull.setStatus(f.piId!, "succeeded"); wFull.setRefunded(f.piId!, "true"); wFull.expireKeys();
  const fullAfter = await gatedSequence(wFull);
  assertEquals([fullAfter.http, fullAfter.code, fullAfter.clientSecretReturned], [409, ALREADY_PAID_CODE, false], "support-refunded in full, no rebate, key expired: refused and routed to support (D-413 annotation, Dustin 2026-11-05)");
  const fullPre = await checkClaimHasNotPaid({ fetchFn: wFull.fetchFn, apiBase: API, basicAuth: wFull.basicAuth, claimId: CLAIM, loadOrders: () => loadHoverOrders(wFull.sb(), CLAIM), log: () => {} });
  assertEquals(fullPre.kind === "paid" && fullPre.reason, "refunded");
  assertEquals(alertKindFor(fullPre), null, "support already handled a refunded payment: no paid-without-order alert");
  const wPartial = paidWorld();
  const p = await gatedSequence(wPartial);
  wPartial.setStatus(p.piId!, "succeeded"); wPartial.setRefunded(p.piId!, "partial"); wPartial.expireKeys();
  assertEquals((await gatedSequence(wPartial)).code, ALREADY_PAID_CODE);
  const wFlight = paidWorld();
  const q = await gatedSequence(wFlight);
  wFlight.setStatus(q.piId!, "processing"); wFlight.expireKeys();
  assertEquals((await gatedSequence(wFlight)).code, ALREADY_PAID_CODE);
});

// REVIEW at 0bb18e05, F1: a refunded intent that the loop met FIRST hid a second, paid, order-less intent (no paid_without_order alert).
Deno.test("gh-3356 (2c-2) a claim with BOTH a fully refunded intent and a paid, order-less intent raises paid_without_order whichever Stripe lists first (paid-first and refunded-first)", async () => {
  for (const refundedFirst of [true, false]) {
    const w = paidWorld();
    const a = await gatedSequence(w, CLAIM, { amount: 2263 });
    const b = await gatedSequence(w, CLAIM, { amount: 2264 }); // a different price is a different idempotency key: a second intent on the same claim
    assert(a.piId && b.piId && a.piId !== b.piId);
    const [refundedId, paidId] = refundedFirst ? [a.piId, b.piId] : [b.piId, a.piId];
    w.setStatus(refundedId, "succeeded"); w.setRefunded(refundedId, "true");
    w.setStatus(paidId, "succeeded"); // paid, no hover_orders row
    w.expireKeys();
    const v = await checkClaimHasNotPaid({ fetchFn: w.fetchFn, apiBase: API, basicAuth: w.basicAuth, claimId: CLAIM, loadOrders: () => loadHoverOrders(w.sb(), CLAIM), log: () => {} });
    assertEquals(v.kind === "paid" && [v.reason, v.paymentIntentId, v.hasOrderRow], ["succeeded", paidId, false], `refundedFirst=${refundedFirst}`);
    assertEquals(alertKindFor(v), "paid_without_order", `refundedFirst=${refundedFirst}: Dustin's D-413 signal must fire`);
    assertEquals(refusalFor(v)?.status, 409);
  }
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

Deno.test("gh-3356 (2e) the lookups and the cancels use the SAME Stripe key as the create; with another key every call is a 401 and the gate fails CLOSED (never allows)", async () => {
  const w = paidWorld({ basicAuth: "VEVTVC1LRVk6" }); // a test claim's key
  await gatedSequence(w);
  w.expireKeys();
  await gatedSequence(w); // second run cancels the first intent
  assert(w.state.gets.length >= 1 && w.state.cancels.length === 1);
  for (const g of w.state.gets) assertEquals(g.auth, "Basic VEVTVC1LRVk6");
  // the gate handed the LIVE key on a test-key world: Stripe says 401 to everything, the verdict is "unavailable"
  const wrong = paidWorld({ basicAuth: "VEVTVC1LRVk6" });
  const r = await gatedSequence(wrong, CLAIM, { deps: { basicAuth: "QUJD" } });
  assertEquals([r.http, r.code], [503, PAID_CHECK_UNAVAILABLE_CODE]);
  assertEquals(wrong.createCalls().length, 0);
});

// ── 3. paid claim while the key is still held ──────────────────────────────────────────────────────────────────────────────────
Deno.test("gh-3356 (3) paid claim while the key is held, search sees it: refused BEFORE the create, no second intent", async () => {
  const w = paidWorld();
  const first = await gatedSequence(w);
  w.setStatus(first.piId!, "succeeded");
  const createsBefore = w.createCalls().length;
  const again = await gatedSequence(w); // key still live
  assertEquals([again.http, again.code, again.clientSecretReturned], [409, ALREADY_PAID_CODE, false]);
  assertEquals(w.createCalls().length, createsBefore);
  assertEquals(w.intents.size, 1);
});

Deno.test("gh-3356 (3b) paid while the key is held and Stripe search has not indexed it yet: the replayed (stale) intent is re-read and its secret is NOT handed back", async () => {
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
  const res = await w.fetchFn(`${API}/payment_intents`, { method: "POST", headers: { Authorization: "Basic QUJD", "Idempotency-Key": standardIdempotencyKey(metadata, 2263) }, body: buildStandardCreateForm({ amount: 2263, currency: "usd", description: "x", metadata }).toString() });
  const pi = await res.clone().json();
  const deps = { fetchFn: w.fetchFn, apiBase: API, basicAuth: "QUJD", log: () => {} };
  w.state.gets.length = 0;
  assertEquals((await assertCreatedIntentNotPaid(deps, { ...pi, created: 1_000_000 }, res, 1_000_010)).kind, "not_paid");
  assertEquals(w.state.gets.length, 0, "fresh and not replayed: no re-read");
  w.setStatus(pi.id, "succeeded");
  assertEquals((await assertCreatedIntentNotPaid(deps, { ...pi, created: 1_000_000 }, res, 1_000_000 + 3600)).kind, "paid");
  assertEquals(w.state.gets.length, 1, "an hour old, no header: re-read, and it is paid");
});

// ── 3d. older unpaid intents (an old tab) are cancelled, safely ──────────────────────────────────────────────────────────────
Deno.test("gh-3356 (3d) an old tab's unpaid intent is CANCELLED once the buyer has a newer one, so it cannot be paid after the newer one succeeds", async () => {
  const w = paidWorld();
  const tabA = await gatedSequence(w); // tab A loads the form: intent P1
  w.expireKeys(); // time passes with tab A open
  const tabB = await gatedSequence(w); // reload in tab B: P2, and P1 is superseded
  assertEquals(tabB.cancelled, [tabA.piId]);
  assertEquals(w.statusOf(tabA.piId!), "canceled");
  w.setStatus(tabB.piId!, "succeeded"); // tab B pays
  // tab A tries to confirm P1: Stripe would refuse a cancelled intent
  assertEquals(w.statusOf(tabA.piId!), "canceled", "P1 is no longer chargeable");
});

Deno.test("NEGATIVE CONTROL (3d): without the cancel step the old tab's intent stays chargeable after the newer one is paid (the second charge)", async () => {
  const w = paidWorld();
  const tabA = await gatedSequence(w, CLAIM, { cancel: false });
  w.expireKeys();
  const tabB = await gatedSequence(w, CLAIM, { cancel: false });
  w.setStatus(tabB.piId!, "succeeded");
  assertEquals(w.statusOf(tabA.piId!), "requires_payment_method", "still payable: a second $22.63 charge is possible");
  assertEquals(w.state.cancels.length, 0);
});

Deno.test("gh-3356 (3e) the intent handed back is never cancelled, even when it is a replay and an OLDER one exists", async () => {
  const w = paidWorld();
  const p0 = await mainSequence(w); // P0, an old tab
  w.expireKeys();
  const p1 = await mainSequence(w); // P1, newer, key live
  const r = await gatedSequence(w); // reload: the keyed create replays P1
  assertEquals(r.piId, p1.piId);
  assertEquals(r.cancelled, [p0.piId]);
  assertEquals(w.state.cancels, [p0.piId], "only the older intent was cancelled");
  assertEquals(w.statusOf(p1.piId!), "requires_payment_method");
});

Deno.test("gh-3356 (3f) requires_action (a 3-D Secure step may be open in another tab) is NEVER cancelled; processing is a payment in flight and refuses", async () => {
  const w = paidWorld();
  const p0 = await mainSequence(w);
  w.setStatus(p0.piId!, "requires_action");
  w.expireKeys();
  const r = await gatedSequence(w);
  assertEquals(r.http, 200);
  assertEquals(w.state.cancels.length, 0);
  assertEquals(w.statusOf(p0.piId!), "requires_action");
  const w2 = paidWorld();
  const q0 = await mainSequence(w2);
  w2.setStatus(q0.piId!, "processing");
  w2.expireKeys();
  assertEquals((await gatedSequence(w2)).code, ALREADY_PAID_CODE);
  assertEquals(w2.state.cancels.length, 0);
});

Deno.test("gh-3356 (3f2) the re-read just before the cancel is a second guard: a stale search view says requires_payment_method but the intent is now requires_action (3-D Secure open in another tab): NOT cancelled", async () => {
  const w = paidWorld();
  const p0 = await mainSequence(w);
  w.setStatus(p0.piId!, "requires_action");
  w.state.staleSearch[p0.piId!] = "requires_payment_method";
  w.expireKeys();
  const r = await gatedSequence(w);
  assertEquals(r.http, 200);
  assertEquals(w.state.cancels.length, 0);
  assertEquals(w.statusOf(p0.piId!), "requires_action");
});

Deno.test("gh-3356 (3g) a cancel that FAILS (HTTP 500, network error, unreadable intent) never stops the purchase", async () => {
  for (const arm of ["http500", "throw", "unreadable"] as const) {
    const w = paidWorld();
    const p0 = await mainSequence(w);
    w.expireKeys();
    if (arm !== "unreadable") w.state.cancelMode = arm;
    const orig = w.fetchFn;
    // "unreadable": the search still lists P0, but reading P0 on its own (the pre-cancel re-read) fails
    const failP0Read = ((url: string, init: RequestInit) =>
      new URL(url).pathname.endsWith(`/${p0.piId}`) && String(init.method) === "GET"
        ? Promise.resolve(new Response("{}", { status: 500 }))
        : orig(url, init)) as typeof fetch;
    const r = await gatedSequence(w, CLAIM, { deps: arm === "unreadable" ? { fetchFn: failP0Read } : {} });
    assertEquals(r.http, 200, arm);
    assert(r.clientSecretReturned, arm);
    assertEquals(r.cancelled, [], arm + ": nothing was cancelled, and that is fine");
  }
});

Deno.test("gh-3356 (3h) a confirm in another tab wins the race: the cancel is refused with 'succeeded', so the new intent is NOT handed back (409)", async () => {
  const w = paidWorld();
  const p0 = await mainSequence(w);
  w.expireKeys();
  w.state.cancelMode = "confirm_wins"; // between the read and the cancel, tab A's confirm lands
  const r = await gatedSequence(w);
  assertEquals([r.http, r.code, r.clientSecretReturned], [409, ALREADY_PAID_CODE, false]);
  assertEquals(w.statusOf(p0.piId!), "succeeded");
});

Deno.test("gh-3356 (3i) a stale search view (shows requires_payment_method, the intent has since succeeded): the pre-cancel re-read sees it and refuses; nothing is cancelled", async () => {
  const w = paidWorld();
  const p0 = await mainSequence(w);
  w.setStatus(p0.piId!, "succeeded");
  w.state.staleSearch[p0.piId!] = "requires_payment_method";
  w.expireKeys();
  const r = await gatedSequence(w);
  assertEquals([r.http, r.code], [409, ALREADY_PAID_CODE]);
  assertEquals(w.state.cancels.length, 0);
});

Deno.test("gh-3356 (3j) only this claim's intents are cancelled, and at most MAX_CANCELS per request (the rest are left, the purchase still proceeds)", async () => {
  const w = paidWorld();
  const other = await mainSequence(w, OTHER_CLAIM);
  const olds: string[] = [];
  for (let i = 0; i < MAX_CANCELS + 2; i++) { olds.push((await mainSequence(w)).piId!); w.expireKeys(); }
  const r = await gatedSequence(w);
  assertEquals(r.http, 200);
  assertEquals(w.state.cancels.length, MAX_CANCELS);
  assert(!w.state.cancels.includes(other.piId!), "another claim's intent is never touched");
  assertEquals(w.statusOf(other.piId!), "requires_payment_method");
  assertEquals(olds.filter((id) => w.statusOf(id) === "canceled").length, MAX_CANCELS);
});

Deno.test("gh-3356 (3k) a cancel the Stripe API answers with 'processing' (the other tab's confirm is in flight): treated as paid, 409, nothing handed back", async () => {
  const w = paidWorld();
  const p0 = await mainSequence(w);
  w.expireKeys();
  w.state.cancelMode = "processing_wins";
  const r = await gatedSequence(w);
  assertEquals([r.http, r.code, r.clientSecretReturned], [409, ALREADY_PAID_CODE, false]);
  assertEquals(w.statusOf(p0.piId!), "processing");
  // negative control: the same race with a cancel answer of an unrelated state ('canceled' already) is NOT paid
  const w2 = paidWorld();
  await mainSequence(w2);
  w2.expireKeys();
  const orig = w2.fetchFn;
  w2.state.cancelMode = "ok";
  const answersWithOtherState = ((url: string, init: RequestInit) =>
    /\/cancel$/.test(url) ? Promise.resolve(new Response(JSON.stringify({ error: { code: "payment_intent_unexpected_state", payment_intent: { id: "pi_1", status: "canceled" } } }), { status: 400 })) : orig(url, init)) as typeof fetch;
  const r2 = await gatedSequence(w2, CLAIM, { deps: { fetchFn: answersWithOtherState } });
  assertEquals(r2.http, 200, "an error answer whose intent is 'canceled' is not a payment");
});

Deno.test("gh-3356 (3l) metadata scope: an intent the search returns that belongs to ANOTHER claim, or to another type, is never cancelled (the paid decision is deliberately NOT scoped: an over-matching search can only make the gate refuse, never allow)", async () => {
  const w = paidWorld();
  const otherClaim = await mainSequence(w, OTHER_CLAIM);
  // a different type on the same claim, made through the fake's base create
  const res = await w.fetchFn(`${API}/payment_intents`, { method: "POST", headers: { Authorization: `Basic ${w.basicAuth}`, "Idempotency-Key": "other-type-key" }, body: buildStandardCreateForm({ amount: 5000, currency: "usd", description: "x", metadata: { claim_id: CLAIM, type: "something_else" } }).toString() });
  const otherType = (await res.json()).id as string;
  w.state.searchInjected = [otherClaim.piId!, otherType];
  const r = await gatedSequence(w);
  assertEquals(r.http, 200);
  assertEquals(w.state.cancels.length, 0, "nothing foreign was cancelled");
  assertEquals(w.statusOf(otherType), "requires_payment_method");
});

Deno.test("gh-3356 (3m) PRICE A -> B -> A while the key is held: the replayed A intent was cancelled by the B request, so it is NOT handed back (503 with its own code), no cancel runs, an operator alert is raised, and the live B intent is untouched", async () => {
  const w = paidWorld();
  const a = await gatedSequence(w, CLAIM, { amount: 2263 });
  const b = await gatedSequence(w, CLAIM, { amount: 2500 });
  assertEquals([a.http, b.http], [200, 200]);
  assertEquals(w.statusOf(a.piId!), "canceled", "the B request superseded the A intent");
  const cancelsBefore = w.state.cancels.length;
  const again = await gatedSequence(w, CLAIM, { amount: 2263 });
  assertEquals([again.http, again.code, again.clientSecretReturned, again.piId], [503, CANCELLED_REPLAY_CODE, false, null]);
  assertEquals(String(CANCELLED_REPLAY_CODE) === String(PAID_CHECK_UNAVAILABLE_CODE), false, "its own code, so the page does not say could-not-check");
  assertEquals(w.state.cancels.length, cancelsBefore, "no cancel ran on this request");
  assertEquals(w.statusOf(b.piId!), "requires_payment_method", "the live intent survives");
  // the verdict is its own kind, and it DOES raise an operator alert: a homeowner is stuck and a person must know
  const verdict = await assertCreatedIntentNotPaid(
    { fetchFn: w.fetchFn, apiBase: API, basicAuth: w.basicAuth, log: () => {} },
    { id: a.piId!, created: Math.floor(Date.now() / 1000) }, new Response("{}", { headers: { "Idempotent-Replayed": "true" } }));
  assertEquals(verdict, { kind: "cancelled_replay", paymentIntentId: a.piId! });
  assertEquals(alertKindFor(verdict), "cancelled_replay");
  // why a body-only check cannot catch this: the replayed create body is the FIRST response, whose status is still requires_payment_method
  const metadata = { claim_id: CLAIM, type: "hover_measurement", variant: "e" };
  const raw = await w.fetchFn(`${API}/payment_intents`, { method: "POST", headers: { Authorization: `Basic ${w.basicAuth}`, "Idempotency-Key": standardIdempotencyKey(metadata, 2263) }, body: buildStandardCreateForm({ amount: 2263, currency: "usd", description: "x", metadata }).toString() });
  assertEquals([raw.headers.get("Idempotent-Replayed"), (await raw.json()).status], ["true", "requires_payment_method"], "the replay looks live; only a re-read shows it is cancelled");
  // the customer can pay again once Stripe has removed the key: A then gets a fresh intent
  w.expireKeys();
  const later = await gatedSequence(w, CLAIM, { amount: 2263 });
  assertEquals(later.http, 200);
  assert(later.piId !== a.piId && later.piId !== b.piId);
});

Deno.test("gh-3356 (3n) the replay of a LIVE intent (same tab reload, same price) is still handed back: the canceled refusal fires only for a cancelled intent", async () => {
  const w = paidWorld();
  const a = await gatedSequence(w, CLAIM, { amount: 2263 });
  const again = await gatedSequence(w, CLAIM, { amount: 2263 });
  assertEquals([again.http, again.piId], [200, a.piId]);
});

// REVIEW at afc53f50, F1: a fully REFUNDED payment whose key is still held is replayed with a stale status; its secret must not be handed back.
Deno.test("gh-3356 (3q) a replayed intent that SUCCEEDED and was fully refunded is NOT handed back: it is the 409 already-paid refusal (D-413 annotation 2026-11-05), and stays so after the key expires", async () => {
  const w = paidWorld();
  const a = await gatedSequence(w);
  assertEquals(a.http, 200);
  w.setStatus(a.piId!, "succeeded"); w.setRefunded(a.piId!, "true"); // paid, then refunded outside the rebate flow; the key is still held
  const again = await gatedSequence(w);
  assertEquals([again.http, again.code, again.clientSecretReturned, again.piId], [409, ALREADY_PAID_CODE, false, null], "the page shows the existing already-paid sentence, which points to support");
  const sb = w.sb();
  const pre = await checkClaimHasNotPaid({ fetchFn: w.fetchFn, apiBase: API, basicAuth: w.basicAuth, claimId: CLAIM, loadOrders: () => loadHoverOrders(sb, CLAIM), log: () => {} });
  assertEquals(pre.kind, "paid", "NEGATIVE CONTROL: before this change the pre-check said not_paid for this same state, which is what let a repurchase through once the key expired");
  const raw = await w.fetchFn(`${API}/payment_intents/${a.piId}?expand[]=latest_charge`, { method: "GET", headers: { Authorization: `Basic ${w.basicAuth}` } });
  assertEquals(evaluatePaymentIntent(await raw.json()), "refunded");
  // a partial refund is paid (409), unchanged
  const w2 = paidWorld();
  const p = await gatedSequence(w2); w2.setStatus(p.piId!, "succeeded"); w2.setRefunded(p.piId!, "partial");
  assertEquals((await gatedSequence(w2)).code, ALREADY_PAID_CODE);
  // after Stripe removes the key the refunded claim is STILL refused (no self-repurchase)
  w.expireKeys();
  const later = await gatedSequence(w);
  assertEquals([later.http, later.code], [409, ALREADY_PAID_CODE]);
});

// REVIEW at dc5f4927: the replay re-read hands a secret back ONLY for an unpaid status.
Deno.test("gh-3356 (3s) replay re-read allowlist: the three unpaid statuses are handed back; a malformed or unknown 200 fails to 503 (unavailable); succeeded (fully refunded) is the paid verdict, reason refunded", async () => {
  const mk = (body: unknown) => ({
    fetchFn: (() => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }))) as typeof fetch,
    apiBase: API, basicAuth: "QUJD", log: () => {},
  });
  const replay = new Response("{}", { headers: { "Idempotent-Replayed": "true" } });
  for (const status of ["requires_payment_method", "requires_confirmation", "requires_action"]) {
    const v = await assertCreatedIntentNotPaid(mk({ id: "pi_x1", status }), { id: "pi_x1" }, replay);
    assertEquals(v.kind, "not_paid", status);
  }
  for (const body of [{ id: "pi_x1" }, { id: "pi_x1", status: "" }, { id: "pi_x1", status: "requires_capture" }, { id: "pi_x1", status: 7 }, null]) {
    const v = await assertCreatedIntentNotPaid(mk(body), { id: "pi_x1" }, replay);
    assertEquals(v.kind, "unavailable", JSON.stringify(body));
    const r = refusalFor(v);
    assertEquals([r?.status, r?.body.code], [503, PAID_CHECK_UNAVAILABLE_CODE]);
  }
  const refunded = await assertCreatedIntentNotPaid(mk({ id: "pi_x1", status: "succeeded", amount: 2263, amount_refunded: 2263, latest_charge: { refunded: true, amount_refunded: 2263, amount: 2263 } }), { id: "pi_x1" }, replay);
  assertEquals(refunded, { kind: "paid", reason: "refunded", paymentIntentId: "pi_x1", hasOrderRow: false });
  const rr = refusalFor(refunded);
  assertEquals([rr?.status, rr?.body.code], [409, ALREADY_PAID_CODE]);
  assertEquals(alertKindFor(refunded), null);
});

// REVIEW at afc53f50, F2: the supersede branch determined nothing about an order row and raised no alert.
Deno.test("gh-3356 (3r) an older intent found paid while superseding: the order row is read for THAT intent (not assumed), so a paid homeowner with no order alerts on this refusal too", async () => {
  const w = paidWorld();
  const deps = (rows: Row[] | null, error: unknown = null) => ({ loadOrders: () => Promise.resolve({ rows: rows as HoverOrderRow[] | null, error }), log: () => {} });
  const none = await supersededPaidVerdict(deps([]), "pi_older");
  assertEquals([none.kind, (none as { hasOrderRow?: boolean }).hasOrderRow, alertKindFor(none)], ["paid", false, "paid_without_order"]);
  const has = await supersededPaidVerdict(deps([orderFor("pi_older")]), "pi_older");
  assertEquals([(has as { hasOrderRow?: boolean }).hasOrderRow, alertKindFor(has)], [true, null]);
  const other = await supersededPaidVerdict(deps([orderFor("pi_other")]), "pi_older");
  assertEquals(alertKindFor(other), "paid_without_order", "an order for a different intent is not an order for this one");
  const upgrade = await supersededPaidVerdict(deps([orderFor("pi_older", { product_code: "roof_upgrade_detailed" })]), "pi_older");
  assertEquals(alertKindFor(upgrade), "paid_without_order", "the contractor upgrade never counts");
  assertEquals(alertKindFor(await supersededPaidVerdict(deps(null, new Error("db down")), "pi_older")), "paid_without_order", "an unreadable orders table alerts (bounded) rather than staying quiet");
  assertEquals(alertKindFor(await supersededPaidVerdict({ loadOrders: () => Promise.reject(new Error("x")), log: () => {} }, "pi_older")), "paid_without_order");
  void w;
  // wiring in index.ts: the verdict comes from supersededPaidVerdict, the refusal is logged through logPaidGateRefusal, no hard-coded hasOrderRow: true
  const branch = indexSource.slice(indexSource.indexOf("if (supersede.paid) {"), indexSource.indexOf("gh-2078c / D-330"));
  assert(branch.includes("await supersededPaidVerdict(paidGateDeps, supersede.paid.id)") && branch.includes('logPaidGateRefusal(supabase, supabaseUrl, supabaseKey, racePaid, metadata.claim_id, "superseded intent paid")'));
  assert(!/hasOrderRow:\s*true/.test(branch), "NEGATIVE CONTROL: the hard-coded hasOrderRow: true is gone (it is what silenced the alert)");
  assert(/^[a-z_ ]{1,40}$/.test("superseded intent paid"), "the stage text passes the alert's stage validation");
});

// No grace period (the 300-second grace of d64225d6 left a paid homeowner with no order and no alert: 30 s and 299 s refused with 0 alert rows).
Deno.test("gh-3356 (3o) a paid claim with no order row alerts on the FIRST refused request whatever the charge's age (30 s, 299 s, 301 s, a day); an order row means no alert", async () => {
  const w = paidWorld();
  const p0 = await gatedSequence(w);
  w.setStatus(p0.piId!, "succeeded");
  const run = async () => {
    const sb = w.sb();
    return await checkClaimHasNotPaid({ fetchFn: w.fetchFn, apiBase: API, basicAuth: w.basicAuth, claimId: CLAIM, loadOrders: () => loadHoverOrders(sb, CLAIM), log: () => {} });
  };
  for (const age of [30, 299, 301, 86400]) {
    w.state.chargeAgeSeconds = age;
    const v = await run();
    assertEquals([age, v.kind, alertKindFor(v)], [age, "paid", "paid_without_order"]);
  }
  w.orders.push(orderFor(p0.piId));
  assertEquals(alertKindFor(await run()), null, "an order row exists: nothing to alert");
});

Deno.test("gh-3356 (3p) the replay re-read alerts at once too, and alertKindFor maps every verdict; the grace code is gone from the gate and from index.ts", async () => {
  const w = paidWorld();
  const p0 = await gatedSequence(w);
  w.setStatus(p0.piId!, "succeeded");
  const deps = { fetchFn: w.fetchFn, apiBase: API, basicAuth: w.basicAuth, claimId: CLAIM, loadOrders: () => Promise.resolve({ rows: [], error: null }), log: () => {} };
  const replayRes = new Response("{}", { headers: { "Idempotent-Replayed": "true" } });
  for (const age of [20, 7200]) {
    w.state.chargeAgeSeconds = age;
    assertEquals(alertKindFor(await assertCreatedIntentNotPaid(deps, { id: p0.piId!, created: 1 }, replayRes)), "paid_without_order");
  }
  assertEquals(alertKindFor({ kind: "unavailable", why: "x" }), "check_unavailable");
  assertEquals(alertKindFor({ kind: "cancelled_replay", paymentIntentId: "pi_1" }), "cancelled_replay");
  assertEquals(alertKindFor({ kind: "not_paid" }), null);
  assertEquals(alertKindFor({ kind: "paid", reason: "succeeded", paymentIntentId: "pi_1", hasOrderRow: true }), null);
  const gateSrc = await Deno.readTextFile(new URL("./measurement-paid-gate.ts", import.meta.url));
  for (const src of [gateSrc, indexSource]) assert(!/recentlyPaid|ORDER_GRACE|chargeIsRecent|shouldAlertPaidWithoutOrder|nowSeconds\?:/.test(src), "no grace period left");
  assert(indexSource.includes("const kind = alertKindFor(verdict);"), "index.ts takes the alert from alertKindFor");
});

// ── 4. a Stripe or database lookup failure fails CLOSED with a retry code ────────────────────────────────────────────────────
Deno.test("gh-3356 (4) every lookup failure (search 500, network, bad shape, more than a page, stalled body, orders read error, retrieve 500) refuses with the retry code and creates nothing", async () => {
  const cases: [string, (w: World) => void][] = [
    ["search http 500", (w) => { w.state.searchMode = "http500"; }],
    ["search network error", (w) => { w.state.searchMode = "throw"; }],
    ["search answer not understood", (w) => { w.state.searchMode = "badshape"; }],
    ["search has_more", (w) => { w.state.searchMode = "has_more"; }],
    ["orders read error", (w) => { w.state.ordersError = { code: "XX000", message: "db down" }; }],
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

Deno.test("gh-3356 (4a) a search whose BODY stalls after the headers is cut off at the timeout (fails closed, promptly); the old headers-only bound would hang", async () => {
  const w = paidWorld();
  w.state.searchMode = "stall_body";
  const t0 = Date.now();
  const v = await Promise.race([
    checkClaimHasNotPaid({ fetchFn: w.fetchFn, apiBase: API, basicAuth: "QUJD", claimId: CLAIM, loadOrders: async () => ({ rows: [], error: null }), timeoutMs: 40, log: () => {} }),
    new Promise<string>((r) => setTimeout(() => r("HUNG"), 800)),
  ]);
  assertEquals((v as { kind: string }).kind, "unavailable");
  assert(Date.now() - t0 < 700);
  // NEGATIVE CONTROL: the pre-fix pattern (fetchStripeWithTimeout, then an unbounded .json()) never returns
  const u = `${API}/payment_intents/search?query=${encodeURIComponent("metadata['claim_id']:'" + CLAIM + "' AND metadata['type']:'hover_measurement'")}&limit=100&expand[]=data.latest_charge`;
  const old = await Promise.race([
    (async () => (await fetchStripeWithTimeout(w.fetchFn, u, { method: "GET", headers: { Authorization: "Basic QUJD" } }, 40)).json())(),
    new Promise<string>((r) => setTimeout(() => r("HUNG"), 300)),
  ]);
  assertEquals(old, "HUNG", "bounding only the headers leaves the body unbounded");
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
  const open = await gatedSequence(w, CLAIM, { failOpen: true });
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

// ── 4d. the fake is strict, so a wrong request shape fails here instead of in production ───────────────────────────────────────
Deno.test("gh-3356 (4d) the fake Stripe REJECTS an unsupported search query or a missing/unknown expand (so the gate's exact request is what is tested)", async () => {
  const w = paidWorld();
  const get = (u: string) => w.fetchFn(u, { method: "GET", headers: { Authorization: "Basic QUJD" } });
  const q = encodeURIComponent(`metadata['claim_id']:'${CLAIM}' AND metadata['type']:'hover_measurement'`);
  assertEquals((await get(`${API}/payment_intents/search?query=${q}&limit=100&expand[]=data.latest_charge`)).status, 200);
  assertEquals((await get(`${API}/payment_intents/search?query=${encodeURIComponent(`metadata["claim_id"]:"${CLAIM}"`)}&limit=100`)).status, 400, "wrong quoting");
  assertEquals((await get(`${API}/payment_intents/search?query=${q}&limit=100&expand[]=latest_charge`)).status, 400, "wrong expand path for search");
  assertEquals((await get(`${API}/payment_intents/search?query=${q}&limit=500`)).status, 400, "limit over 100");
  assertEquals((await get(`${API}/payment_intents/search?query=${q}&bogus=1`)).status, 400, "unknown parameter");
  // without the expand, latest_charge is only an id, so a refund cannot be seen and the payment counts as paid
  const bare = await (await get(`${API}/payment_intents/search?query=${q}&limit=100`)).json();
  assert(bare.data.length === 0);
  const first = await gatedSequence(w);
  w.setStatus(first.piId!, "succeeded"); w.setRefunded(first.piId!, "true");
  const noExpand = await (await get(`${API}/payment_intents/${first.piId}`)).json();
  assertEquals(typeof noExpand.latest_charge, "string");
  const expanded = await (await get(`${API}/payment_intents/${first.piId}?expand[]=latest_charge`)).json();
  assertEquals(expanded.latest_charge.refunded, true);
  assertEquals((await get(`${API}/payment_intents/${first.piId}?expand[]=customer`)).status, 400);
  assertEquals((await w.fetchFn(`${API}/payment_intents/${first.piId}`, { method: "GET", headers: { Authorization: "Basic WRONG" } })).status, 401);
});

// ── 4e. the orders read and its columns ──────────────────────────────────────────────────────────────────────────────────────
Deno.test("gh-3356 (4e) every column the orders read names exists on hover_orders (derived from the migrations); a misspelled one fails like PostgREST", async () => {
  for (const c of HOVER_ORDER_SELECT.split(",").map((x) => x.trim())) assert(SCHEMA.hover_orders.has(c), `hover_orders has no column ${c}`);
  assert(SCHEMA.hover_orders.has("claim_id"));
  const sb = fakeSupabase(SCHEMA, { hover_orders: [orderFor("pi_1")] });
  const ok = await loadHoverOrders(sb, CLAIM);
  assertEquals(ok.error, null);
  assertEquals(ok.rows!.length, 1);
  // NEGATIVE CONTROL: the same read with a misspelled column is an error, which the gate turns into the 503 for every buyer
  const bad = await sb.from("hover_orders").select("homeowner_stripe_payment_intent").eq("claim_id", CLAIM).not("homeowner_stripe_payment_intent_id", "is", null);
  assertEquals((bad as unknown as { error: { code: string } }).error.code, "42703");
  const badEq = await sb.from("hover_orders").select(HOVER_ORDER_SELECT).eq("claimid", CLAIM);
  assertEquals((badEq as unknown as { error: { code: string } }).error.code, "42703");
  // and through the gate: an orders read error is "unavailable", never "allow"
  const w = paidWorld();
  const v = await checkClaimHasNotPaid({ fetchFn: w.fetchFn, apiBase: API, basicAuth: "QUJD", claimId: CLAIM, loadOrders: async () => ({ rows: null, error: (bad as unknown as { error: unknown }).error }), log: () => {} });
  assertEquals(v.kind, "unavailable");
});

Deno.test("gh-3356 (4f) an order row for the claim on a hover_orders read that works: the gate sees it end to end through the fake client", async () => {
  const w = paidWorld();
  const first = await gatedSequence(w);
  w.setStatus(first.piId!, "succeeded");
  w.orders.push(orderFor(first.piId, {}, CLAIM));
  w.orders.push(orderFor("pi_other", {}, OTHER_CLAIM));
  w.expireKeys();
  w.state.searchLag = true;
  assertEquals((await gatedSequence(w)).code, ALREADY_PAID_CODE);
});

// ── 5. the key and the keyed create body are untouched ───────────────────────────────────────────────────────────────────────
Deno.test("gh-3356 (5) the gated flow sends the SAME key and the SAME create body as main's, so a paid claim's reload while the key is held still gets the same intent", async () => {
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
  const iCancel = indexSource.indexOf("await cancelSupersededIntents(");
  const iAttach = indexSource.indexOf("await attachVariantMetadata(");
  assert(iGate > -1, "index.ts calls checkClaimHasNotPaid");
  assert(iGate < iBuild && iBuild < iCreate, "the check precedes the create form and the create");
  assert(iReplay > iCreate && iReplay < iCancel && iCancel < iAttach, "replay re-read, then the cancel of older intents, then the variant/description update");
  assert(/if \(metadata\.type === "hover_measurement"\) \{\s*const paidVerdict = await checkClaimHasNotPaid\(/.test(indexSource), "gated on hover_measurement");
  assert(indexSource.includes("const idempotencyKey = standardIdempotencyKey(metadata, amount);"), "the key is still standardIdempotencyKey(metadata, amount)");
  assert(indexSource.includes('"Idempotency-Key": idempotencyKey,'), "the create still sends exactly that key");
});

Deno.test("gh-3356 (6b) index.ts: a refusal returns the verdict's own status and body, not a 200 with a secret; a cancel result of 'paid' refuses", () => {
  assert(indexSource.includes("refusalFor(paidVerdict)") && indexSource.includes("refusalFor(replayVerdict)"));
  assert(/paidRefusal\.status/.test(indexSource) && /replayRefusal\.status/.test(indexSource));
  assert(/if \(supersede\.paid\) \{[\s\S]*?raceRefusal\.status/.test(indexSource), "supersede.paid returns the refusal");
  assert(/cancelSupersededIntents\(paidGateDeps, supersedeCandidates, paymentIntentData\.id\)/.test(indexSource), "the intent being handed back is the one kept");
});

Deno.test("gh-3356 (6d) index.ts: the cancel of older intents is CALLED, with the candidates the pre-check found, after the replay re-read, and its 'paid' answer refuses (deleting the call, or feeding it nothing, fails here)", () => {
  assert(indexSource.includes("const supersede = await cancelSupersededIntents(paidGateDeps, supersedeCandidates, paymentIntentData.id);"), "the cancel call exists in index.ts");
  assert(/if \(paidVerdict\.kind === "not_paid"\) supersedeCandidates = paidVerdict\.cancelable \?\? \[\];/.test(indexSource), "its candidates come from the pre-check verdict");
  assert(indexSource.includes("let supersedeCandidates: string[] = [];"));
  // the index.ts alert wiring: every refusal asks alertKindFor (no grace period, a cancelled replay alerts)
  assert(indexSource.includes("const kind = alertKindFor(verdict);"));
});

Deno.test("gh-3356 (6c) index.ts: the gate and the cancel use THE create's Stripe key (basicAuth, built from keyChoice.key), never another source", () => {
  const block = indexSource.slice(indexSource.indexOf("const paidGateDeps = {"), indexSource.indexOf("let supersedeCandidates"));
  assert(block.length > 50 && /\bbasicAuth,/.test(block), "paidGateDeps carries basicAuth");
  assert(!/Deno\.env|STRIPE_SECRET|STRIPE_LIVE|STRIPE_TEST|btoa\(/.test(block), "and no other key source");
  assert(/const stripeSecretKey = keyChoice\.key;\s*const basicAuth = btoa\(`\$\{stripeSecretKey\}:`\);/.test(indexSource), "basicAuth is built from keyChoice.key");
  assert(indexSource.includes("Authorization: `Basic ${basicAuth}`,\n          \"Content-Type\": \"application/x-www-form-urlencoded\",\n          \"Idempotency-Key\": idempotencyKey"), "the create uses the same basicAuth");
  assert(indexSource.includes("loadOrders: () => loadHoverOrders(supabase, String(metadata.claim_id))"), "orders come from loadHoverOrders (columns checked in 4e)");
});

Deno.test("gh-3356 refusalFor: not_paid is no refusal; paid is a 409 with a code; unavailable is a 503 with a different code", () => {
  assertEquals(refusalFor({ kind: "not_paid" }), null);
  assertEquals(refusalFor({ kind: "paid", reason: "succeeded", paymentIntentId: "pi_1", hasOrderRow: false })!.status, 409);
  assertEquals(refusalFor({ kind: "unavailable", why: "x" })!.status, 503);
  assertEquals(new Set<string>([ALREADY_PAID_CODE, PAID_CHECK_UNAVAILABLE_CODE]).size, 2);
});
