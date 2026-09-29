// gh-2356 -- unit tests for the shared server-side synthetic-traffic guard (Meta CAPI / GA4 Measurement Protocol dispatch gate).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { shouldSuppressAnalyticsDispatch, syntheticTrafficReason } from "./synthetic-traffic.ts";

Deno.test("real row and real attribution: not suppressed", () => {
  assertEquals(syntheticTrafficReason({ isTest: false, isSynthetic: false, params: { fbclid: "IwAR3realClickId", utm_campaign: "120234567890", utm_source: "facebook" } }), null);
  assertEquals(syntheticTrafficReason(null), null);
  assertEquals(syntheticTrafficReason({}), null);
  assertEquals(syntheticTrafficReason({ params: { utm_campaign: "testimonials-spring", utm_source: "qatar-roofing" } }), null);
});

Deno.test("is_test / is_synthetic rows are suppressed", () => {
  assertEquals(syntheticTrafficReason({ isTest: true }), "is_test");
  assertEquals(syntheticTrafficReason({ isSynthetic: true }), "is_synthetic");
});

Deno.test("qa=1 and oq_internal=1 are suppressed", () => {
  assertEquals(syntheticTrafficReason({ params: { qa: "1" } }), "qa_flag");
  assertEquals(syntheticTrafficReason({ params: { oq_internal: "1" } }), "oq_internal_flag");
});

Deno.test("synthetic fbclid / utm values are suppressed", () => {
  assertEquals(syntheticTrafficReason({ params: { fbclid: "TESTFBCLID123" } }), "synthetic_value");
  assertEquals(syntheticTrafficReason({ params: { fbclid: "CEO75STUB1234567890" } }), "synthetic_value");
  assertEquals(syntheticTrafficReason({ params: { utm_source: "test_walk" } }), "synthetic_value");
  assertEquals(syntheticTrafficReason({ params: { utm_campaign: "QA-run-7" } }), "synthetic_value");
});

Deno.test("dispatch gate: suppressed traffic logs exactly one info line, with no attribution value in it", () => {
  const lines: string[] = [];
  const suppressed = shouldSuppressAnalyticsDispatch("meta_capi", "Purchase", { params: { fbclid: "TESTFBCLID123" } }, (m) => lines.push(m));
  assertEquals(suppressed, true);
  assertEquals(lines.length, 1);
  assert(!lines[0].includes("TESTFBCLID123"));
  assert(lines[0].includes("meta_capi") && lines[0].includes("Purchase") && lines[0].includes("synthetic_value"));
});

Deno.test("dispatch gate: real traffic is not suppressed and logs nothing", () => {
  const lines: string[] = [];
  assertEquals(shouldSuppressAnalyticsDispatch("ga4_mp", "payment_completed", { isTest: false }, (m) => lines.push(m)), false);
  assertEquals(lines.length, 0);
});

Deno.test("dispatch gate: a throwing logger never breaks the caller", () => {
  assertEquals(shouldSuppressAnalyticsDispatch("ga4_mp", "x", { isTest: true }, () => { throw new Error("boom"); }), true);
});
