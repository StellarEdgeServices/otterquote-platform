// gh-3051 -- tests for the server-side GA4 Measurement Protocol sender. No network: fetch, the row loader and the idempotency
// marker are all injected. NEGATIVE CONTROLS are labelled; each asserts the failure the rail exists to prevent would be caught.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest, isInternalEmail } from "./handler.ts";
import { assertNoPii, buildPayload, clientIdFor, cleanParam, type ConversionRow, isTooOld, MAX_ROW_AGE_MS, MP_COLLECT_URL, MP_DEBUG_URL, sendGa4 } from "./ga4-mp.ts";

const KEY = "service-role-key-for-test";
const SECRET = "ga4-secret-for-test";
const ID = "147641e5-1111-4222-8333-444455556666";
const USER = "d04a29db-aaaa-4bbb-8ccc-ddddeeeeffff";

const LEAD: ConversionRow = { kind: "lead", id: ID, email: "jane.doe@gmail.com", variant: "e", utmSource: "chatgpt.com", utmMedium: "referral", isSynthetic: false, createdAt: new Date().toISOString() };
const CLAIM: ConversionRow = { kind: "claim", id: ID, userId: USER, email: "jane.doe@gmail.com", isTest: false, utmSource: "google", utmMedium: "cpc", createdAt: new Date().toISOString() };
const BODY_OF = { lead: { event_type: "router_contact_submitted", id: ID }, claim: { event_type: "claim_started", id: ID } };

interface Calls { urls: string[]; bodies: string[]; logs: string[]; marks: Set<string>; released: string[] }
function harness(row: ConversionRow | null, over: { fetchImpl?: typeof fetch; secret?: string | undefined; marker?: "claimed" | "duplicate" | "error"; stateful?: boolean } = {}) {
  const c: Calls = { urls: [], bodies: [], logs: [], marks: new Set(), released: [] };
  const fetchImpl: typeof fetch = over.fetchImpl ?? ((async (u: string | URL | Request, init?: RequestInit) => {
    c.urls.push(String(u)); c.bodies.push(String(init?.body));
    return new Response(JSON.stringify({ validationMessages: [] }), { status: 200 });
  }) as typeof fetch);
  // Wrap so URL / body are recorded even when a test overrides fetchImpl.
  const rec: typeof fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    if (over.fetchImpl) { c.urls.push(String(u)); c.bodies.push(String(init?.body)); }
    return await fetchImpl(u as string, init);
  }) as typeof fetch;
  const deps = {
    serviceRoleKey: KEY,
    apiSecret: "secret" in over ? over.secret : SECRET,
    loadRow: async () => row,
    claimMarker: async (e: string, id: string) => {
      if (over.marker) return over.marker;
      if (over.stateful) { const k = e + id; if (c.marks.has(k)) return "duplicate" as const; c.marks.add(k); }
      return "claimed" as const;
    },
    releaseMarker: async (e: string, id: string) => { c.released.push(e + id); c.marks.delete(e + id); },
    fetchImpl: over.fetchImpl ? rec : fetchImpl,
    log: (m: string) => c.logs.push(m),
  };
  const call = (body: unknown, bearer = KEY) =>
    handleRequest(new Request("https://x/ga4-mp-conversion", { method: "POST", headers: { Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) }), deps);
  return { c, call };
}

// ---- happy path: all three conversions go to the PRODUCTION endpoint with the right event name ----
for (const kind of ["lead", "claim"] as const) {
  const row = { lead: LEAD, claim: CLAIM }[kind];
  const name = { lead: "router_contact_submitted", claim: "claim_started" }[kind];
  Deno.test(`real ${kind} row sends exactly one ${name} to /mp/collect`, async () => {
    const h = harness(row);
    const res = await (await h.call(BODY_OF[kind])).json();
    assertEquals(res.sent, true);
    assertEquals(h.c.urls.length, 1);
    assert(h.c.urls[0].startsWith(MP_COLLECT_URL + "?measurement_id=G-D1Y1TLGEFY&api_secret="));
    assert(!h.c.urls[0].includes("/debug/"));
    const p = JSON.parse(h.c.bodies[0]);
    assertEquals(p.events.length, 1);
    assertEquals(p.events[0].name, name);
    assertEquals(p.events[0].params.event_source, "server");
    assert(/^\d+\.\d+$/.test(p.client_id));
  });
}

Deno.test("arm / utm params ride along on a lead", async () => {
  const lead = JSON.parse((await (async () => { const h = harness(LEAD); await h.call(BODY_OF.lead); return h.c.bodies[0]; })()));
  assertEquals(lead.events[0].params.arm, "e");
  assertEquals(lead.events[0].params.source, "chatgpt.com");
  assertEquals(lead.events[0].params.medium, "referral");
});

Deno.test("two claims of one user share one client_id; a different user does not", async () => {
  const a = await buildPayload(CLAIM), b = await buildPayload({ ...CLAIM, id: "99999999-1111-4222-8333-444455556666" });
  assertEquals(a.client_id, b.client_id);
  assert(a.client_id !== (await clientIdFor("some-other-user")));
  assertEquals(await clientIdFor(USER), await clientIdFor(USER)); // stable
});

// ---- RAIL: is_test / synthetic rows send nothing to production ----
for (const [label, row, body] of [
  ["is_test claim", { ...CLAIM, isTest: true }, BODY_OF.claim],
  ["is_synthetic lead", { ...LEAD, isSynthetic: true }, BODY_OF.lead],
  ["synthetic utm value (ceo75walk...)", { ...LEAD, utmSource: "ceo75walk1790609196" }, BODY_OF.lead],
  ["internal address (@otterquote-internal.test)", { ...LEAD, email: "walk@otterquote-internal.test" }, BODY_OF.lead],
  ["internal address on a claim owner (@stellaredgeservices.com)", { ...CLAIM, email: "x@stellaredgeservices.com" }, BODY_OF.claim],
] as Array<[string, ConversionRow, unknown]>) {
  Deno.test(`is_test/synthetic: ${label} sends NOTHING (fetch never called, no marker consumed)`, async () => {
    const h = harness(row, { stateful: true });
    const res = await (await h.call(body)).json();
    assertEquals(res, { sent: false, reason: "suppressed" });
    assertEquals(h.c.urls.length, 0);
    assertEquals(h.c.marks.size, 0);
  });
}

Deno.test("NEGATIVE CONTROL: the same rows with the flag cleared DO send (the suppression tests are not vacuous)", async () => {
  for (const [row, body] of [[{ ...CLAIM, isTest: false }, BODY_OF.claim], [{ ...LEAD, isSynthetic: false, email: "walk@gmail.com" }, BODY_OF.lead]] as Array<[ConversionRow, unknown]>) {
    const h = harness(row);
    assertEquals((await (await h.call(body)).json()).sent, true);
    assertEquals(h.c.urls.length, 1);
  }
});

Deno.test("debug mode sends an is_test row ONLY to /debug/mp/collect, returns validationMessages, never the production URL", async () => {
  const h = harness({ ...CLAIM, isTest: true });
  const res = await (await h.call({ ...BODY_OF.claim, debug: true })).json();
  assertEquals(res.sent, true);
  assertEquals(res.validationMessages, []);
  assertEquals(h.c.urls.length, 1);
  assert(h.c.urls[0].startsWith(MP_DEBUG_URL));
  assert(!h.c.urls[0].startsWith(MP_COLLECT_URL + "?"));
  assertEquals(h.c.marks.size, 0);
});

// ---- RAIL: no personal data in the payload ----
Deno.test("payload contains no PII: no email, phone, name, address, raw uuid; hashed client_id only", async () => {
  const rich: ConversionRow = { ...CLAIM, email: "Jane.Doe@gmail.com", utmSource: "google", utmMedium: "cpc" };
  for (const row of [LEAD, rich]) {
    const s = JSON.stringify(await buildPayload(row));
    assert(!/@/.test(s), "no @ anywhere");
    assert(!s.includes(row.id), "raw row id absent");
    if (row.userId) assert(!s.includes(row.userId), "raw user id absent");
    assert(!/jane|doe|gmail/i.test(s));
    assert(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s), "no uuid");
    assert(!/\d{10}/.test(s.replace(/"timestamp_micros":\d+/, "").replace(/"client_id":"[\d.]+"/, "")), "no phone-length digit run outside client_id/timestamp");
  }
});

Deno.test("PII-shaped attribution values are dropped, not forwarded (email / phone / uuid in utm_source)", async () => {
  for (const bad of ["jane.doe@gmail.com", "317-555-0142", "3175550142", ID]) assertEquals(cleanParam(bad), undefined, bad);
  const p = await buildPayload({ ...LEAD, utmSource: "jane.doe@gmail.com", utmMedium: "317-555-0142", variant: ID });
  assertEquals(Object.keys(p.events[0].params).sort(), ["engagement_time_msec", "event_source"]);
});

Deno.test("NEGATIVE CONTROL: the PII scan itself catches a leaking payload", () => {
  const leak = { client_id: "1.2", events: [{ name: "sign_up", params: { who: "jane.doe@gmail.com" } }] };
  let threw = false; try { assertNoPii(leak, LEAD); } catch { threw = true; }
  assert(threw);
  threw = false; try { assertNoPii({ client_id: "1.2", events: [{ name: "x", params: { id: ID } }] }, LEAD); } catch { threw = true; }
  assert(threw);
});

// ---- RAIL: a GA4 failure never throws and never breaks the caller ----
Deno.test("GA4 network error does not throw; returns sent:false; marker released for a later retry; secret never logged", async () => {
  const h = harness(CLAIM, { fetchImpl: (() => Promise.reject(new TypeError(`fetch failed: https://www.google-analytics.com/mp/collect?api_secret=${SECRET}`))) as typeof fetch });
  const r = await h.call(BODY_OF.claim);
  assertEquals(r.status, 200);
  assertEquals((await r.json()).sent, false);
  assertEquals(h.c.released.length, 1);
  assert(!h.c.logs.join("\n").includes(SECRET));
});

Deno.test("GA4 HTTP 500 does not throw", async () => {
  const h = harness(CLAIM, { fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch });
  const r = await (await h.call(BODY_OF.claim)).json();
  assertEquals(r, { sent: false, reason: "http_error", status: 500 });
});

Deno.test("GA4 hang: aborts at the timeout and returns, does not hang the caller", async () => {
  const hang: typeof fetch = ((_u: string | URL | Request, init?: RequestInit) =>
    new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as typeof fetch;
  const t0 = Date.now();
  const r = await sendGa4(CLAIM, { secret: SECRET, fetchImpl: hang, timeoutMs: 50, log: () => {} });
  assertEquals(r, { sent: false, reason: "timeout" });
  assert(Date.now() - t0 < 1000);
});

Deno.test("row loader / marker throwing does not throw out of the handler (user's insert is never affected)", async () => {
  const deps = {
    serviceRoleKey: KEY, apiSecret: SECRET, log: () => {},
    loadRow: async () => { throw new Error("db down"); },
    claimMarker: async () => "claimed" as const, releaseMarker: async () => {},
  };
  const r = await handleRequest(new Request("https://x", { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: JSON.stringify(BODY_OF.lead) }), deps);
  assertEquals(r.status, 200);
  assertEquals((await r.json()).reason, "internal");
});

Deno.test("missing GA4_MP_API_SECRET: no send, no marker, no throw (safe to deploy before the secret exists)", async () => {
  const h = harness(CLAIM, { secret: undefined, stateful: true });
  assertEquals((await (await h.call(BODY_OF.claim)).json()).reason, "no_secret");
  assertEquals(h.c.urls.length, 0);
  assertEquals(h.c.marks.size, 0);
});

// ---- RAIL: one event per row ----
Deno.test("dedupe: a retried delivery for the same row sends once", async () => {
  const h = harness(CLAIM, { stateful: true });
  assertEquals((await (await h.call(BODY_OF.claim)).json()).sent, true);
  assertEquals((await (await h.call(BODY_OF.claim)).json()).reason, "duplicate");
  assertEquals(h.c.urls.length, 1);
});

Deno.test("NEGATIVE CONTROL: with no marker store the same retry sends twice (proves the marker is what dedupes)", async () => {
  const h = harness(CLAIM); // claimMarker always 'claimed'
  await h.call(BODY_OF.claim); await h.call(BODY_OF.claim);
  assertEquals(h.c.urls.length, 2);
});

Deno.test("marker store unavailable: fail closed (no send), never throws", async () => {
  const h = harness(CLAIM, { marker: "error" });
  assertEquals((await (await h.call(BODY_OF.claim)).json()).reason, "marker_error");
  assertEquals(h.c.urls.length, 0);
});

// ---- auth + input ----
Deno.test("rejects a wrong bearer (401), a non-uuid id and an unknown event_type (400); loader never reached", async () => {
  const h = harness(CLAIM);
  assertEquals((await h.call(BODY_OF.claim, "not-the-key")).status, 401);
  assertEquals((await h.call({ event_type: "claim_started", id: "1; drop table claims" })).status, 400);
  assertEquals((await h.call({ event_type: "purchase", id: ID })).status, 400);
  assertEquals((await h.call({ event_type: "sign_up", id: USER })).status, 400); // sign_up is not a server-side event (CTO ruling, PR #3054 review)
  assertEquals(h.c.urls.length, 0);
});

Deno.test("internal-address matcher: internal yes, ordinary consumer no", () => {
  assert(isInternalEmail("a@otterquote.com")); assert(isInternalEmail("b@example.com")); assert(isInternalEmail("x@otterquote-internal.test"));
  assert(!isInternalEmail("jane@live.com")); assert(!isInternalEmail("protest@gmail.com")); assert(!isInternalEmail(null));
  assertStringIncludes(MP_COLLECT_URL, "google-analytics.com/mp/collect");
});

// ---- RAIL (CTO ruling, PR #3054 review): rows older than 72 h are never sent (bulk insert / restore / backfill replay guard) ----
const HOURS = 3600 * 1000;
for (const [label, row, body] of [
  ["claim created 73 h ago", { ...CLAIM, createdAt: new Date(Date.now() - 73 * HOURS).toISOString() }, BODY_OF.claim],
  ["lead created 30 days ago (a restore)", { ...LEAD, createdAt: new Date(Date.now() - 30 * 24 * HOURS).toISOString() }, BODY_OF.lead],
  ["claim with no created_at (fails closed)", { ...CLAIM, createdAt: null }, BODY_OF.claim],
  ["claim with unparseable created_at (fails closed)", { ...CLAIM, createdAt: "not a date" }, BODY_OF.claim],
] as Array<[string, ConversionRow, unknown]>) {
  Deno.test(`age guard: ${label} sends NOTHING and consumes no marker`, async () => {
    const h = harness(row, { stateful: true });
    assertEquals(await (await h.call(body)).json(), { sent: false, reason: "too_old" });
    assertEquals(h.c.urls.length, 0);
    assertEquals(h.c.marks.size, 0);
  });
}

Deno.test("NEGATIVE CONTROL: a row 71 h old and a row created just now DO send (the age guard is not vacuous)", async () => {
  for (const age of [0, 71 * HOURS]) {
    const h = harness({ ...CLAIM, createdAt: new Date(Date.now() - age).toISOString() });
    assertEquals((await (await h.call(BODY_OF.claim)).json()).sent, true);
    assertEquals(h.c.urls.length, 1);
  }
});

Deno.test("isTooOld boundary: exactly MAX_ROW_AGE_MS is allowed, one ms more is not", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  assertEquals(isTooOld(new Date(now - MAX_ROW_AGE_MS).toISOString(), now), false);
  assertEquals(isTooOld(new Date(now - MAX_ROW_AGE_MS - 1).toISOString(), now), true);
});

Deno.test("debug mode is not subject to the age guard (it records nothing)", async () => {
  const h = harness({ ...CLAIM, createdAt: new Date(Date.now() - 30 * 24 * HOURS).toISOString() });
  const r = await (await h.call({ ...BODY_OF.claim, debug: true })).json();
  assertEquals(r.sent, true);
  assert(h.c.urls[0].startsWith(MP_DEBUG_URL));
});
