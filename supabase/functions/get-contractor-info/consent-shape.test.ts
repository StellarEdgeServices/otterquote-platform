// Deno unit tests for get-contractor-info's gh-1916 consent-shaping logic.
// Run: deno test supabase/functions/get-contractor-info/consent-shape.test.ts
//
// gh-1916 CLOSE-REVIEW FAIL 5777750121: get-contractor-info returned neither
// sms_opt_in nor the phone fields, so the send path (notify-contractors,
// process-dunning, the homeowner nudge) could never deliver even to a
// genuinely consented contractor — it failed safe, but it blocked proving
// closes-on (b). These tests are the negative control: opted-in, opted-out
// (false), and null/undefined (never-asked) all round-trip through
// shapeConsentFields/isSmsConsented the way the send-path gate needs.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { isSmsConsented, shapeConsentFields } from "./consent-shape.ts";

// ── Opted-in: sms_opt_in === true ───────────────────────────────────────────

Deno.test("opted-in: sms_opt_in stays true and consent metadata is returned", () => {
  const shaped = shapeConsentFields({
    phone: "+15551234567",
    notification_phones: ["+15559998888"],
    sms_opt_in: true,
    sms_opt_in_at: "2026-09-15T02:21:47Z",
    sms_consent_text_version: "contractor-v2-2026-09-15",
  });
  assertEquals(shaped, {
    phone: "+15551234567",
    notification_phones: ["+15559998888"],
    sms_opt_in: true,
    sms_opt_in_at: "2026-09-15T02:21:47Z",
    sms_consent_text_version: "contractor-v2-2026-09-15",
  });
  assertEquals(isSmsConsented(shaped.sms_opt_in), true);
});

// ── Opted-out: sms_opt_in === false (reserved for a future STOP path) ──────

Deno.test("opted-out (false): collapses to null, not a bare false, and withholds consent metadata", () => {
  const shaped = shapeConsentFields({
    phone: "+15551234567",
    notification_phones: null,
    sms_opt_in: false,
    sms_opt_in_at: "2026-01-01T00:00:00Z", // stale/inconsistent row — must not leak
    sms_consent_text_version: "contractor-v1-2026-09-14",
  });
  assertEquals(shaped.sms_opt_in, null);
  assertEquals(shaped.sms_opt_in_at, null);
  assertEquals(shaped.sms_consent_text_version, null);
  assertEquals(isSmsConsented(shaped.sms_opt_in), false);
});

// ── Null / never-asked: the default for every pre-migration row (v115) ─────

Deno.test("null (never asked): sms_opt_in and consent metadata are all null", () => {
  const shaped = shapeConsentFields({
    phone: "+15551234567",
    notification_phones: ["+15559998888"],
    sms_opt_in: null,
    sms_opt_in_at: null,
    sms_consent_text_version: null,
  });
  assertEquals(shaped.sms_opt_in, null);
  assertEquals(shaped.sms_opt_in_at, null);
  assertEquals(shaped.sms_consent_text_version, null);
  assertEquals(isSmsConsented(shaped.sms_opt_in), false);
});

Deno.test("undefined (field omitted on the row): treated the same as null", () => {
  const shaped = shapeConsentFields({ phone: "+15551234567" });
  assertEquals(shaped.sms_opt_in, null);
  assertEquals(shaped.sms_opt_in_at, null);
  assertEquals(shaped.sms_consent_text_version, null);
  assertEquals(isSmsConsented(shaped.sms_opt_in), false);
});

// ── Phone fields pass through untouched regardless of consent ──────────────

Deno.test("phone and notification_phones pass through even when not consented (caller-side gate is on sms_opt_in, not phone presence)", () => {
  const shaped = shapeConsentFields({
    phone: "+15551234567",
    notification_phones: ["+15559998888", "+15557776666"],
    sms_opt_in: null,
  });
  assertEquals(shaped.phone, "+15551234567");
  assertEquals(shaped.notification_phones, ["+15559998888", "+15557776666"]);
});

Deno.test("missing phone fields default to null, not undefined", () => {
  const shaped = shapeConsentFields({ sms_opt_in: true, sms_opt_in_at: "x", sms_consent_text_version: "v" });
  assertEquals(shaped.phone, null);
  assertEquals(shaped.notification_phones, null);
});

// ── isSmsConsented is the exact strict-equality gate every consumer uses ───

Deno.test("isSmsConsented: only literal true passes; truthy non-boolean values do not", () => {
  assertEquals(isSmsConsented(true), true);
  assertEquals(isSmsConsented(false), false);
  assertEquals(isSmsConsented(null), false);
  assertEquals(isSmsConsented(undefined), false);
  // deno-lint-ignore no-explicit-any
  assertEquals(isSmsConsented("true" as any), false);
  // deno-lint-ignore no-explicit-any
  assertEquals(isSmsConsented(1 as any), false);
});
