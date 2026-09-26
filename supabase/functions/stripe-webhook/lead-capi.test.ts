// deno test --allow-read=. supabase/functions/stripe-webhook/lead-capi.test.ts
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { decideLeadCapiPerson, isLeadMeasurementPurchase, resolveLeadForCapi } from "./lead-capi.ts";

Deno.test("isLeadMeasurementPurchase only matches the lead_measurement_order type", () => {
  assertEquals(isLeadMeasurementPurchase({ metadata: { type: "lead_measurement_order" } }), true);
  assertEquals(isLeadMeasurementPurchase({ metadata: { type: "hover_measurement" } }), false);
  assertEquals(isLeadMeasurementPurchase({ metadata: { type: "measurement_order" } }), false);
  assertEquals(isLeadMeasurementPurchase({ metadata: {} }), false);
  assertEquals(isLeadMeasurementPurchase({}), false);
  assertEquals(isLeadMeasurementPurchase(null), false);
});

Deno.test("decideLeadCapiPerson fails closed on a lookup failure", () => {
  assertEquals(decideLeadCapiPerson({ leadId: "lead-1", leadLookupFailed: true }), { skip: true, reason: "lead_lookup_failed" });
});

Deno.test("decideLeadCapiPerson skips when there is no lead id", () => {
  assertEquals(decideLeadCapiPerson({ leadId: null, leadLookupFailed: false }), { skip: true, reason: "no_lead_id" });
});

Deno.test("decideLeadCapiPerson sends when a lead id resolved cleanly", () => {
  assertEquals(decideLeadCapiPerson({ leadId: "lead-1", leadLookupFailed: false }), { skip: false, reason: null });
});

Deno.test("resolveLeadForCapi treats an empty-string email (phone-only lead) as no email, not a skip", () => {
  const r = resolveLeadForCapi({ id: "lead-1", email: "", is_synthetic: false });
  assertEquals(r.email, null);
});

Deno.test("resolveLeadForCapi surfaces is_synthetic for the test-traffic gate", () => {
  assertEquals(resolveLeadForCapi({ id: "lead-1", email: "a@b.com", is_synthetic: true }).isSynthetic, true);
  assertEquals(resolveLeadForCapi({ id: "lead-1", email: "a@b.com", is_synthetic: null }).isSynthetic, false);
});

Deno.test("resolveLeadForCapi handles a null lead (lookup found nothing) without throwing", () => {
  const r = resolveLeadForCapi(null);
  assertEquals(r.email, null);
  assertEquals(r.isSynthetic, false);
});
