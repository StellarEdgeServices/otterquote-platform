// Deno unit tests for send-sms's sender-selection + auth-decision logic
// (gh-1843 residual: platform-path send verification, code-buildable half).
// Run: deno test supabase/functions/send-sms/sender-selection.test.ts
//
// Exercises resolveTwilioSender / resolveAuthorization against plain object
// literals and fake resolvers — no live Supabase client, no live Twilio
// account, no network access, no SMS is ever sent by this file. This does
// NOT close gh-1843 on its own (the issue's closes-on requires an actual
// delivered message through the platform path, which is a real send — an
// executive act, not built here); it covers logic that had zero prior test
// coverage and that a live send would otherwise be the only way to exercise.

import { assertEquals, assertThrows } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { resolveAuthorization, resolveTwilioSender } from "./sender-selection.ts";

// ── resolveTwilioSender ──────────────────────────────────────────────────

Deno.test("sender: MessagingServiceSid preferred when both are configured", () => {
  const result = resolveTwilioSender({
    messagingServiceSid: "MG01f353f28aa32a65076d7e9e41eb53ab",
    phoneNumber: "+13178277532",
  });
  assertEquals(result, {
    field: "MessagingServiceSid",
    value: "MG01f353f28aa32a65076d7e9e41eb53ab",
  });
});

Deno.test("sender: falls back to From when messagingServiceSid is unset", () => {
  const result = resolveTwilioSender({
    messagingServiceSid: null,
    phoneNumber: "+13178277532",
  });
  assertEquals(result, { field: "From", value: "+13178277532" });
});

Deno.test("sender: falls back to From when messagingServiceSid is an empty string", () => {
  const result = resolveTwilioSender({
    messagingServiceSid: "",
    phoneNumber: "+13178277532",
  });
  assertEquals(result, { field: "From", value: "+13178277532" });
});

// Negative control for this issue's own callout: "a secret that exists and
// is blank reads, to anyone checking, as a secret that is configured." A
// whitespace-only value is the blank-but-present case an empty-string check
// alone does NOT catch — this is the fail-first proof that resolveTwilioSender
// closes that gap rather than silently sending MessagingServiceSid=" ".
Deno.test("sender: whitespace-only messagingServiceSid is treated as unset, not as configured", () => {
  const result = resolveTwilioSender({
    messagingServiceSid: "   ",
    phoneNumber: "+13178277532",
  });
  assertEquals(result, { field: "From", value: "+13178277532" });
});

Deno.test("sender: whitespace-only phoneNumber with no messaging service SID throws (fail-closed)", () => {
  assertThrows(
    () => resolveTwilioSender({ messagingServiceSid: null, phoneNumber: "   " }),
    Error,
    "No Twilio sender configured",
  );
});

Deno.test("sender: throws when neither is configured (matches pre-existing fail-closed behavior)", () => {
  assertThrows(
    () => resolveTwilioSender({ messagingServiceSid: null, phoneNumber: null }),
    Error,
    "No Twilio sender configured",
  );
});

Deno.test("sender: leading/trailing whitespace on an otherwise-valid SID is trimmed", () => {
  const result = resolveTwilioSender({
    messagingServiceSid: "  MG01f353f28aa32a65076d7e9e41eb53ab  ",
    phoneNumber: null,
  });
  assertEquals(result, {
    field: "MessagingServiceSid",
    value: "MG01f353f28aa32a65076d7e9e41eb53ab",
  });
});

// ── resolveAuthorization ─────────────────────────────────────────────────

const SERVICE_ROLE_KEY = "service-role-test-key-not-real";

Deno.test("auth: exact service-role key is authorized (trusted internal caller)", async () => {
  const result = await resolveAuthorization(
    `Bearer ${SERVICE_ROLE_KEY}`,
    SERVICE_ROLE_KEY,
    async () => {
      throw new Error("getUser must not be called when the service-role key matches");
    },
  );
  assertEquals(result, { authorized: true, reason: "service_role" });
});

Deno.test("auth: a token that resolves to a real user is authorized", async () => {
  const result = await resolveAuthorization(
    "Bearer some-user-jwt",
    SERVICE_ROLE_KEY,
    async (token) => {
      assertEquals(token, "some-user-jwt");
      return { user: { id: "00000000-0000-0000-0000-000000000001" } };
    },
  );
  assertEquals(result, { authorized: true, reason: "user_jwt" });
});

Deno.test("auth: missing Authorization header is rejected without calling getUser", async () => {
  const result = await resolveAuthorization("", SERVICE_ROLE_KEY, async () => {
    throw new Error("getUser must not be called with no token");
  });
  assertEquals(result, { authorized: false, reason: "missing_token" });
});

Deno.test("auth: anon-key-only / bogus token that getUser rejects is unauthorized (closes the open relay)", async () => {
  const result = await resolveAuthorization(
    "Bearer anon-or-garbage-token",
    SERVICE_ROLE_KEY,
    async () => null,
  );
  assertEquals(result, { authorized: false, reason: "invalid_token" });
});

Deno.test("auth: getUser resolving with no user is unauthorized", async () => {
  const result = await resolveAuthorization(
    "Bearer expired-or-revoked-jwt",
    SERVICE_ROLE_KEY,
    async () => ({ user: undefined as unknown as { id: string } }),
  );
  assertEquals(result, { authorized: false, reason: "invalid_token" });
});
