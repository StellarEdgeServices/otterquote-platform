import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { PlatformSettingMissingError, resolveRequiredPriceCents } from "./price-setting.ts";

Deno.test("resolveRequiredPriceCents returns the live numeric value", () => {
  assertEquals(resolveRequiredPriceCents("hover_measurement_price", { value: 1500 }, null), 1500);
});

Deno.test("resolveRequiredPriceCents coerces a numeric-string JSONB value", () => {
  assertEquals(resolveRequiredPriceCents("hover_measurement_price", { value: "1500" }, null), 1500);
});

Deno.test("resolveRequiredPriceCents throws — never guesses — when the row is missing", () => {
  assertThrows(
    () => resolveRequiredPriceCents("hover_measurement_price", null, null),
    PlatformSettingMissingError,
    "platform_setting_missing: hover_measurement_price",
  );
});

Deno.test("resolveRequiredPriceCents throws when the read itself errored", () => {
  assertThrows(
    () => resolveRequiredPriceCents("hover_measurement_price", { value: 1500 }, { message: "connection reset" }),
    PlatformSettingMissingError,
  );
});

Deno.test("resolveRequiredPriceCents throws on a null/undefined value", () => {
  assertThrows(() => resolveRequiredPriceCents("hover_measurement_price", { value: null }, null), PlatformSettingMissingError);
  assertThrows(() => resolveRequiredPriceCents("hover_measurement_price", { value: undefined }, null), PlatformSettingMissingError);
});

Deno.test("resolveRequiredPriceCents throws on zero, negative, non-integer, and unparseable values", () => {
  assertThrows(() => resolveRequiredPriceCents("hover_measurement_price", { value: 0 }, null), PlatformSettingMissingError);
  assertThrows(() => resolveRequiredPriceCents("hover_measurement_price", { value: -1500 }, null), PlatformSettingMissingError);
  assertThrows(() => resolveRequiredPriceCents("hover_measurement_price", { value: 15.5 }, null), PlatformSettingMissingError);
  assertThrows(() => resolveRequiredPriceCents("hover_measurement_price", { value: "not-a-number" }, null), PlatformSettingMissingError);
  assertThrows(() => resolveRequiredPriceCents("hover_measurement_price", { value: NaN }, null), PlatformSettingMissingError);
});

Deno.test("gh-1537: a missing setting throws before any Stripe amount comparison could run", () => {
  // verifyHoverPayment (index.ts) calls resolveRequiredPriceCents BEFORE it
  // fetches the PaymentIntent from Stripe. Proving the throw here proves the
  // guard aborts before the fetch — no fabricated expected amount can ever
  // reach the pi.amount !== expectedAmount comparison.
  let thrown = false;
  try {
    resolveRequiredPriceCents("hover_measurement_price", null, null);
  } catch {
    thrown = true;
  }
  assertEquals(thrown, true);
});
