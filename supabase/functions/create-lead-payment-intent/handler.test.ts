// deno test --allow-read=. supabase/functions/create-lead-payment-intent/handler.test.ts
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  buildLeadPaymentIntentForm,
  detectGpcSignal,
  handleRequest,
  leadPaymentIntentIdempotencyKey,
  PlatformSettingMissingError,
  resolveRequiredPriceCents,
  validateBody,
  type Deps,
  type ResolvedLead,
} from "./handler.ts";

const LEAD_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const GOOD_TOKEN = "a".repeat(32);

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://x/functions/v1/create-lead-payment-intent", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function baseDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    resolveLead: (token) =>
      Promise.resolve(token === GOOD_TOKEN ? { leadId: LEAD_ID, email: "jane@example.com", isSynthetic: false } : null),
    readPriceCents: () => Promise.resolve({ row: { value: 1500 }, error: null }),
    checkRateLimit: () => Promise.resolve({ allowed: true }),
    createPaymentIntent: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: { id: "pi_123", client_secret: "pi_123_secret", status: "requires_payment_method", amount: 1500, currency: "usd" },
      }),
    logPlatformAlert: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("validateBody requires a lead_token", () => {
  assertEquals(validateBody({}).ok, false);
  assertEquals(validateBody({ lead_token: "short" }).ok, false);
  assertEquals(validateBody({ lead_token: GOOD_TOKEN }).ok, true);
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

Deno.test("buildLeadPaymentIntentForm never lets the client set the amount -- it is a function of (leadId, priceCents) only", () => {
  const form = buildLeadPaymentIntentForm(LEAD_ID, 1500, false);
  assertEquals(form.get("amount"), "1500");
  assertEquals(form.get("metadata[lead_id]"), LEAD_ID);
  assertEquals(form.get("metadata[type]"), "lead_measurement_order");
  assertEquals(form.get("metadata[ad_sharing_opt_out]"), null);
});

Deno.test("buildLeadPaymentIntentForm stamps the GPC opt-out signal when present", () => {
  const form = buildLeadPaymentIntentForm(LEAD_ID, 1500, true);
  assertEquals(form.get("metadata[ad_sharing_opt_out]"), "1");
});

Deno.test("leadPaymentIntentIdempotencyKey is a pure function of the lead id only", () => {
  assertEquals(leadPaymentIntentIdempotencyKey(LEAD_ID), `lead_measurement_order-${LEAD_ID}`);
});

Deno.test("detectGpcSignal reads Sec-GPC header or body.gpc", () => {
  const h = new Headers({ "Sec-GPC": "1" });
  assertEquals(detectGpcSignal(h, {}), true);
  assertEquals(detectGpcSignal(new Headers(), { gpc: true }), true);
  assertEquals(detectGpcSignal(new Headers(), {}), false);
});

Deno.test("happy path: valid token creates a PaymentIntent", async () => {
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN }), baseDeps());
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.payment_intent_id, "pi_123");
  assertEquals(body.client_secret, "pi_123_secret");
});

Deno.test("NEGATIVE CONTROL: a bad token is rejected with 401 and NO Stripe call is attempted", async () => {
  let stripeCalled = false;
  const deps = baseDeps({
    createPaymentIntent: () => {
      stripeCalled = true;
      return Promise.resolve({ ok: true, status: 200, body: { id: "pi_should_never_exist" } });
    },
  });
  const res = await handleRequest(req({ lead_token: "b".repeat(32) }), deps);
  assertEquals(res.status, 401);
  assertEquals(stripeCalled, false);
});

Deno.test("NEGATIVE CONTROL: an expired token (resolveLead returns null) is rejected, no charge attempted", async () => {
  let stripeCalled = false;
  const deps: Deps = {
    ...baseDeps(),
    resolveLead: () => Promise.resolve(null), // simulates resolve_lead_by_token finding an expired/unknown token
    createPaymentIntent: () => {
      stripeCalled = true;
      return Promise.resolve({ ok: true, status: 200, body: { id: "pi_should_never_exist" } });
    },
  };
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN }), deps);
  assertEquals(res.status, 401);
  assertEquals(stripeCalled, false);
  const body = await res.json();
  assertEquals(typeof body.error, "string");
});

Deno.test("NEGATIVE CONTROL: rate-limited caller is refused before the lead is even resolved", async () => {
  let resolveCalled = false;
  let stripeCalled = false;
  const deps: Deps = {
    ...baseDeps(),
    checkRateLimit: () => Promise.resolve({ allowed: false, reason: "too_many" }),
    resolveLead: () => {
      resolveCalled = true;
      return Promise.resolve({ leadId: LEAD_ID, email: null, isSynthetic: false } as ResolvedLead);
    },
    createPaymentIntent: () => {
      stripeCalled = true;
      return Promise.resolve({ ok: true, status: 200, body: {} });
    },
  };
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN }), deps);
  assertEquals(res.status, 429);
  assertEquals(resolveCalled, false);
  assertEquals(stripeCalled, false);
});

Deno.test("a missing/invalid platform_settings price fails closed (500), no Stripe call", async () => {
  let stripeCalled = false;
  const deps = baseDeps({
    readPriceCents: () => Promise.resolve({ row: null, error: null }),
    createPaymentIntent: () => {
      stripeCalled = true;
      return Promise.resolve({ ok: true, status: 200, body: {} });
    },
  });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN }), deps);
  assertEquals(res.status, 500);
  assertEquals(stripeCalled, false);
});

Deno.test("a Stripe HTTP failure surfaces as 502, not a fabricated success", async () => {
  const deps = baseDeps({
    createPaymentIntent: () => Promise.resolve({ ok: false, status: 402, body: { error: { message: "card declined" } } }),
  });
  const res = await handleRequest(req({ lead_token: GOOD_TOKEN }), deps);
  assertEquals(res.status, 502);
});

Deno.test("GET is rejected with 405", async () => {
  const res = await handleRequest(new Request("https://x/functions/v1/create-lead-payment-intent", { method: "GET" }), baseDeps());
  assertEquals(res.status, 405);
});
