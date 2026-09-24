// gh-2078b / D-330 — Meta CAPI Purchase pure-logic tests. No network, no Deno.env.
import { assertEquals, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildCapiEventId,
  buildCapiPurchasePayload,
  hashEmailSha256,
  MEASUREMENT_ORDER_PI_TYPES,
  sanitizeCapiVariant,
  shouldSendCapiEvent,
} from "./meta-capi.ts";

Deno.test("gh-2078b: event_id is deterministic per paymentIntent (dedupe contract with client pixel)", () => {
  assertEquals(buildCapiEventId("pi_123"), "measurement_purchase:pi_123");
  // Same input -> same output, always -- this is the whole point: gh-2078a's
  // client pixel call must be able to reproduce this exact string.
  assertEquals(buildCapiEventId("pi_123"), buildCapiEventId("pi_123"));
  assertEquals(buildCapiEventId("pi_456") !== buildCapiEventId("pi_123"), true);
});

Deno.test("gh-2078b: shouldSendCapiEvent -- real production traffic always sends", () => {
  assertEquals(
    shouldSendCapiEvent({ livemode: true, claimIsTest: false, testEventCode: null }),
    true,
  );
});

Deno.test("gh-2078b: shouldSendCapiEvent -- Stripe test-mode with NO test_event_code is skipped (acceptance criterion 4)", () => {
  assertEquals(
    shouldSendCapiEvent({ livemode: false, claimIsTest: false, testEventCode: null }),
    false,
  );
});

Deno.test("gh-2078b: shouldSendCapiEvent -- is_test claim on a livemode PI with NO test_event_code is skipped", () => {
  // This is the case a livemode Stripe key charging an internal test claim
  // would hit -- claim.is_test is the second, independent signal.
  assertEquals(
    shouldSendCapiEvent({ livemode: true, claimIsTest: true, testEventCode: null }),
    false,
  );
});

Deno.test("gh-2078b: shouldSendCapiEvent -- test traffic WITH a configured test_event_code sends (Meta's sanctioned test channel)", () => {
  assertEquals(
    shouldSendCapiEvent({ livemode: false, claimIsTest: false, testEventCode: "TEST12345" }),
    true,
  );
});

Deno.test("gh-2078b: shouldSendCapiEvent -- empty-string test_event_code does not count as configured", () => {
  assertEquals(
    shouldSendCapiEvent({ livemode: false, claimIsTest: false, testEventCode: "" }),
    false,
  );
});

Deno.test("gh-2078b: sanitizeCapiVariant -- accepts the closed shape, falls back to 'unknown'", () => {
  assertEquals(sanitizeCapiVariant("d"), "d");
  assertEquals(sanitizeCapiVariant("e13"), "e13");
  assertEquals(sanitizeCapiVariant(undefined), "unknown");
  assertEquals(sanitizeCapiVariant(null), "unknown");
  assertEquals(sanitizeCapiVariant(""), "unknown");
  // Not the vocabulary this is guarding against arm names specifically --
  // it is a SHAPE bound (mirrors lib/track.ts), so anything outside
  // [a-z0-9]{1,8} is rejected regardless of what it is.
  assertEquals(sanitizeCapiVariant("not an arm; DROP TABLE"), "unknown");
  assertEquals(sanitizeCapiVariant("toolongvariantname"), "unknown");
});

Deno.test("gh-2078b: buildCapiPurchasePayload -- never carries raw email, only a hashed em field when present", async () => {
  const hashed = await hashEmailSha256("Homeowner@Example.com ");
  const payload = buildCapiPurchasePayload({
    paymentIntentId: "pi_abc",
    eventTimeSeconds: 1_700_000_000,
    valueUsd: 15.0,
    variant: "d",
    hashedEmail: hashed,
    testEventCode: null,
  });
  const event = (payload.data as Array<Record<string, unknown>>)[0];
  const userData = event.user_data as Record<string, unknown>;
  assertEquals(JSON.stringify(payload).includes("Homeowner@Example.com"), false);
  assertEquals(userData.em, [hashed]);
  assertEquals(event.event_id, "measurement_purchase:pi_abc");
  assertEquals(event.event_name, "Purchase");
  assertEquals((event.custom_data as Record<string, unknown>).value, 15.0);
  assertEquals((event.custom_data as Record<string, unknown>).currency, "USD");
  assertEquals((event.custom_data as Record<string, unknown>).variant, "d");
  assertEquals(payload.test_event_code, undefined);
});

Deno.test("gh-2078b: buildCapiPurchasePayload -- omits user_data.em entirely when no email was resolvable", () => {
  const payload = buildCapiPurchasePayload({
    paymentIntentId: "pi_noemail",
    eventTimeSeconds: 1_700_000_000,
    valueUsd: 15.0,
    variant: "unknown",
    hashedEmail: null,
    testEventCode: null,
  });
  const event = (payload.data as Array<Record<string, unknown>>)[0];
  const userData = event.user_data as Record<string, unknown>;
  assertEquals("em" in userData, false);
});

Deno.test("gh-2078b: buildCapiPurchasePayload -- forwards test_event_code only when provided", () => {
  const payload = buildCapiPurchasePayload({
    paymentIntentId: "pi_test",
    eventTimeSeconds: 1_700_000_000,
    valueUsd: 15.0,
    variant: "unknown",
    hashedEmail: null,
    testEventCode: "TEST99",
  });
  assertEquals(payload.test_event_code, "TEST99");
});

Deno.test("gh-2078b: hashEmailSha256 -- lowercases and trims before hashing (Meta's required convention)", async () => {
  const a = await hashEmailSha256("  Foo@Bar.COM  ");
  const b = await hashEmailSha256("foo@bar.com");
  assertEquals(a, b);
  assertMatch(a, /^[0-9a-f]{64}$/);
});

Deno.test("gh-2078b: MEASUREMENT_ORDER_PI_TYPES -- covers both the current and legacy metadata.type values", () => {
  assertEquals(MEASUREMENT_ORDER_PI_TYPES.has("measurement_order"), true);
  assertEquals(MEASUREMENT_ORDER_PI_TYPES.has("hover_measurement"), true);
  assertEquals(MEASUREMENT_ORDER_PI_TYPES.has("platform_fee"), false);
  assertEquals(MEASUREMENT_ORDER_PI_TYPES.has("deductible_escrow"), false);
});
