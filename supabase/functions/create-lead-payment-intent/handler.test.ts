// deno test --allow-read=. supabase/functions/create-lead-payment-intent/handler.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  buildLeadPaymentIntentForm,
  type ConsentRecord,
  type Deps,
  detectGpcSignal,
  handleRequest,
  leadPaymentIntentIdempotencyKey,
  MEASURE_TERMS_CONSENT_KEY,
  MEASURE_TERMS_CONSENT_TEXT,
  PlatformSettingMissingError,
  resolveRequiredPriceCents,
  validateBody,
} from "./handler.ts";

const LEAD_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const GOOD_TOKEN = "a".repeat(32);
const CREATE = { lead_token: GOOD_TOKEN, terms_accepted: true, consent_text: MEASURE_TERMS_CONSENT_TEXT, page_url: "https://app.otterquote.com/measure-lead" };

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://x/functions/v1/create-lead-payment-intent", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

type Spy = Deps & { creates: Array<{ form: URLSearchParams; key: string }>; consents: ConsentRecord[] };

function baseDeps(overrides: Partial<Deps> = {}): Spy {
  const creates: Array<{ form: URLSearchParams; key: string }> = [];
  const consents: ConsentRecord[] = [];
  const deps: Deps = {
    stripeMode: "live",
    resolveLead: (token) =>
      Promise.resolve(token === GOOD_TOKEN ? { leadId: LEAD_ID, email: "jane@example.com", isSynthetic: false } : null),
    readPriceCents: () => Promise.resolve({ row: { value: 1500 }, error: null }),
    findLeadOrderStatuses: () => Promise.resolve({ statuses: [], error: false }),
    checkRateLimit: () => Promise.resolve({ allowed: true }),
    recordConsent: (c) => {
      consents.push(c);
      return Promise.resolve({ ok: true });
    },
    createPaymentIntent: (form, key) => {
      creates.push({ form, key });
      return Promise.resolve({
        ok: true,
        status: 200,
        body: { id: "pi_123", client_secret: "pi_123_secret", status: "requires_payment_method", amount: Number(form.get("amount")), currency: "usd", livemode: true },
      });
    },
    logPlatformAlert: () => Promise.resolve(),
    ...overrides,
  };
  return Object.assign(deps, { creates, consents });
}

Deno.test("validateBody requires a lead_token; mode defaults to create", () => {
  assertEquals(validateBody({}).ok, false);
  assertEquals(validateBody({ lead_token: "short" }).ok, false);
  const v = validateBody({ lead_token: GOOD_TOKEN });
  assert(v.ok && v.value.mode === "create");
  const p = validateBody({ lead_token: GOOD_TOKEN, mode: "preview" });
  assert(p.ok && p.value.mode === "preview");
});

Deno.test("resolveRequiredPriceCents throws on a missing row (never falls back to a hardcoded price)", () => {
  let threw = false;
  try {
    resolveRequiredPriceCents("hover_measurement_price", null, null);
  } catch (e) {
    threw = e instanceof PlatformSettingMissingError;
  }
  assertEquals(threw, true);
});

// ── L3: the displayed price is the server price ─────────────────────────────────
Deno.test("L3: preview returns the server price (whatever it is) and never calls Stripe or records consent", async () => {
  for (const cents of [1500, 1900]) {
    const deps = baseDeps({ readPriceCents: () => Promise.resolve({ row: { value: cents }, error: null }) });
    const res = await handleRequest(req({ lead_token: GOOD_TOKEN, mode: "preview" }), deps);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { amount: cents, currency: "usd", livemode: true });
    assertEquals(deps.creates.length, 0);
    assertEquals(deps.consents.length, 0);
  }
});

Deno.test("L3: the charge uses the same server price the preview showed", async () => {
  const deps = baseDeps({ readPriceCents: () => Promise.resolve({ row: { value: 1900 }, error: null }) });
  const res = await handleRequest(req(CREATE), deps);
  assertEquals(res.status, 200);
  assertEquals(deps.creates[0].form.get("amount"), "1900");
  assertEquals((await res.json()).amount, 1900);
});

Deno.test("a missing price refuses (500) and alerts -- no PaymentIntent", async () => {
  let alerted = false;
  const deps = baseDeps({
    readPriceCents: () => Promise.resolve({ row: null, error: null }),
    logPlatformAlert: () => { alerted = true; return Promise.resolve(); },
  });
  const res = await handleRequest(req(CREATE), deps);
  assertEquals(res.status, 500);
  assertEquals(alerted, true);
  assertEquals(deps.creates.length, 0);
});

// ── L1: clickwrap consent ───────────────────────────────────────────────────────
Deno.test("L1: an unticked box (terms_accepted missing/false) is refused before any consent row or PaymentIntent", async () => {
  for (const body of [{ lead_token: GOOD_TOKEN }, { ...CREATE, terms_accepted: false }, { ...CREATE, terms_accepted: "true" }]) {
    const deps = baseDeps();
    const res = await handleRequest(req(body), deps);
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals((await res.json()).reason, "consent_required");
    assertEquals(deps.creates.length, 0);
    assertEquals(deps.consents.length, 0);
  }
});

Deno.test("L1: a consent_text that is not the exact approved label is refused (the evidence can never record text that was not shown)", async () => {
  const deps = baseDeps();
  const res = await handleRequest(req({ ...CREATE, consent_text: MEASURE_TERMS_CONSENT_TEXT + " " }), deps);
  assertEquals(res.status, 400);
  assertEquals(deps.creates.length, 0);
});

Deno.test("L1: an accepted create records the assent (key, exact text, page, server-observed IP/UA, versions) BEFORE the PaymentIntent", async () => {
  const order: string[] = [];
  const deps = baseDeps();
  const origConsent = deps.recordConsent;
  const origCreate = deps.createPaymentIntent;
  deps.recordConsent = (c) => { order.push("consent"); return origConsent(c); };
  deps.createPaymentIntent = (f, k) => { order.push("stripe"); return origCreate(f, k); };
  const res = await handleRequest(req(CREATE, { "cf-connecting-ip": "1.2.3.4", "user-agent": "UA/1" }), deps);
  assertEquals(res.status, 200);
  assertEquals(order, ["consent", "stripe"]);
  const c = deps.consents[0];
  assertEquals(c.leadId, LEAD_ID);
  assertEquals(c.consentKey, MEASURE_TERMS_CONSENT_KEY);
  assertEquals(c.consentText, MEASURE_TERMS_CONSENT_TEXT);
  assertEquals(c.ip, "1.2.3.4");
  assertEquals(c.userAgent, "UA/1");
  assertEquals(c.payload.terms_effective, "2026-03-16");
  assertEquals(c.payload.amount_cents, 1500);
});

Deno.test("L1: if the assent cannot be recorded, no PaymentIntent is created", async () => {
  const deps = baseDeps({ recordConsent: () => Promise.resolve({ ok: false }) });
  const res = await handleRequest(req(CREATE), deps);
  assertEquals(res.status, 500);
  assertEquals(deps.creates.length, 0);
});

// ── D10: already ordered ────────────────────────────────────────────────────────
Deno.test("D10: a lead with an awaiting_fulfillment or fulfilled order gets 409 already_ordered -- in preview AND create -- and Stripe is never called", async () => {
  for (const status of ["awaiting_fulfillment", "fulfilled"]) {
    for (const body of [{ lead_token: GOOD_TOKEN, mode: "preview" }, CREATE]) {
      const deps = baseDeps({ findLeadOrderStatuses: () => Promise.resolve({ statuses: [status], error: false }) });
      const res = await handleRequest(req(body), deps);
      assertEquals(res.status, 409);
      const j = await res.json();
      assertEquals(j.already_ordered, true);
      assertEquals(deps.creates.length, 0);
    }
  }
});

Deno.test("NEGATIVE CONTROL (D10): a cancelled or refunded earlier order does not block a new purchase", async () => {
  const deps = baseDeps({ findLeadOrderStatuses: () => Promise.resolve({ statuses: ["cancelled", "refunded"], error: false }) });
  const res = await handleRequest(req(CREATE), deps);
  assertEquals(res.status, 200);
  assertEquals(deps.creates.length, 1);
});

Deno.test("D10: a failed order lookup refuses (fail closed), never charges", async () => {
  const deps = baseDeps({ findLeadOrderStatuses: () => Promise.resolve({ statuses: [], error: true }) });
  const res = await handleRequest(req(CREATE), deps);
  assertEquals(res.status, 503);
  assertEquals(deps.creates.length, 0);
});

Deno.test("D10: the idempotency key changes with the price and the GPC flag, so neither can collide into a Stripe idempotency_error", () => {
  const a = leadPaymentIntentIdempotencyKey(LEAD_ID, 1500, false);
  assertEquals(a, `lead_measurement_order-${LEAD_ID}-1500-gpc0`);
  assert(a !== leadPaymentIntentIdempotencyKey(LEAD_ID, 1500, true));
  assert(a !== leadPaymentIntentIdempotencyKey(LEAD_ID, 1900, false));
});

Deno.test("the create body is a pure function of (lead, price, gpc, is_synthetic) and never takes a client amount", async () => {
  const form = buildLeadPaymentIntentForm(LEAD_ID, 1500, false, false);
  assertEquals(form.get("amount"), "1500");
  assertEquals(form.get("metadata[lead_id]"), LEAD_ID);
  assertEquals(form.get("metadata[type]"), "lead_measurement_order");
  assertEquals(form.get("metadata[ad_sharing_opt_out]"), null);
  const deps = baseDeps();
  await handleRequest(req({ ...CREATE, amount: 1, price: 1 }), deps);
  assertEquals(deps.creates[0].form.get("amount"), "1500");
});

Deno.test("D11: metadata[is_synthetic] rides on the PaymentIntent", async () => {
  const deps = baseDeps({ resolveLead: () => Promise.resolve({ leadId: LEAD_ID, email: null, isSynthetic: true }) });
  await handleRequest(req(CREATE), deps);
  assertEquals(deps.creates[0].form.get("metadata[is_synthetic]"), "1");
  assertEquals(buildLeadPaymentIntentForm(LEAD_ID, 1500, false, false).get("metadata[is_synthetic]"), "0");
});

Deno.test("GPC: Sec-GPC: 1 stamps the opt-out and uses the gpc1 key", async () => {
  const deps = baseDeps();
  await handleRequest(req(CREATE, { "Sec-GPC": "1" }), deps);
  assertEquals(deps.creates[0].form.get("metadata[ad_sharing_opt_out]"), "1");
  assert(deps.creates[0].key.endsWith("-gpc1"));
  assertEquals(detectGpcSignal(new Headers(), { gpc: true }), true);
});

// ── negative controls on the token / rate limit ────────────────────────────────
Deno.test("negative control: a bad/expired token is rejected with 401 and no Stripe call is attempted", async () => {
  const deps = baseDeps();
  const res = await handleRequest(req({ ...CREATE, lead_token: "b".repeat(32) }), deps);
  assertEquals(res.status, 401);
  assertEquals(deps.creates.length, 0);
  assertEquals(deps.consents.length, 0);
});

Deno.test("negative control: a rate-limited caller is refused before the lead is even resolved", async () => {
  let resolved = false;
  const deps = baseDeps({
    checkRateLimit: () => Promise.resolve({ allowed: false, reason: "rate_limit_check_failed" }),
    resolveLead: () => { resolved = true; return Promise.resolve(null); },
  });
  const res = await handleRequest(req(CREATE), deps);
  assertEquals(res.status, 429);
  assertEquals(resolved, false);
});

Deno.test("a Stripe create failure returns 502", async () => {
  const deps = baseDeps({ createPaymentIntent: () => Promise.resolve({ ok: false, status: 400, body: {} }) });
  const res = await handleRequest(req(CREATE), deps);
  assertEquals(res.status, 502);
});

Deno.test("the response carries livemode so the page picks the matching publishable key", async () => {
  const res = await handleRequest(req(CREATE), baseDeps());
  assertEquals((await res.json()).livemode, true);
});
