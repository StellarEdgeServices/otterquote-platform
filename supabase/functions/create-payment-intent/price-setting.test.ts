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

Deno.test("gh-1537 regression: no code path returns the retired 7900 default", () => {
  // The bug this issue was filed for: a hardcoded 7900 ($79) fallback, three
  // price changes stale against the live 1500 ($15) value at audit time.
  // resolveRequiredPriceCents has no fallback branch at all — proven here by
  // asserting the missing-row path throws rather than silently returning
  // 7900 (or any other literal).
  let thrown = false;
  try {
    resolveRequiredPriceCents("hover_measurement_price", null, null);
  } catch (err) {
    thrown = true;
    if (err instanceof Error) {
      assertEquals(err.message.includes("7900"), false);
    }
  }
  assertEquals(thrown, true);
});
