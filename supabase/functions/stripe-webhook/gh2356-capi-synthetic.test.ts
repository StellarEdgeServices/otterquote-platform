// gh-2356 (REVIEW: FAIL 5896203320, must-fix 3) -- the Meta CAPI Purchase gate must read what the webhook can actually see: the claim's
// STORED attribution (claims.fbclid / gclid / utm_*), not PaymentIntent metadata (which never carries them).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const start = index.indexOf("async function handleMeasurementOrderCapiPurchase(");
const body = index.slice(start, start + 12000);

Deno.test("claim lookup selects the stored attribution columns", () => {
  assert(start > 0);
  assert(body.includes('.select("id, user_id, is_test, fbclid, gclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term")'));
  assert(body.includes("claimAttribution = claim as Record<string, unknown>"));
});

Deno.test("gate is fed the claim attribution, not PaymentIntent metadata", () => {
  assert(body.includes('shouldSuppressAnalyticsDispatch("meta_capi", "Purchase", { params: claimAttribution })'));
  assert(!body.includes("params: paymentIntent.metadata"));
});

Deno.test("gate runs after the person decision and before the test-mode decision and any PII lookup / send", () => {
  const gate = body.indexOf('shouldSuppressAnalyticsDispatch("meta_capi"');
  assert(gate > body.indexOf("decideCapiPerson("));
  assert(gate < body.indexOf("shouldSendCapiEvent("));
  assert(gate < body.indexOf("graph.facebook.com") || body.indexOf("graph.facebook.com") === -1);
  if (body.indexOf("sha256") > -1) assert(gate < body.indexOf("sha256"));
});
