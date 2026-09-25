// Deno unit tests for gh-2154 P-4 switch-on hardening round (Ben, bus
// 18:23:17Z item (1)): "cron-auth fails CLOSED when CRON_SECRET unset".
// The first test below flips the old permissive assertion (isCronAuthorized
// with cronSecret unset used to return true for an anonymous caller; it now
// must return false). These fail against the pre-hardening head (merged in
// #2180, PR base b6ea0ecb) where the permissive branch still exists.
// Run: deno test supabase/functions/send-partner-onboarding/cron-auth.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { isCronAuthorized } from "./cron-auth.ts";

const SERVICE_ROLE_KEY = "srv-role-key-abc123";

// --- CRON_SECRET unset (was permissive pre-hardening; now fail-closed) ---

Deno.test("CRON_SECRET unset + no header at all -> REJECTED (was permissive pre-hardening)", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: undefined,
      incomingCronSecret: null,
      authHeader: "",
      serviceRoleKey: SERVICE_ROLE_KEY,
    }),
    false,
  );
});

Deno.test("CRON_SECRET unset + anon-shaped Authorization header -> REJECTED", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: undefined,
      incomingCronSecret: null,
      authHeader: "Bearer anon-or-random-caller-token",
      serviceRoleKey: SERVICE_ROLE_KEY,
    }),
    false,
  );
});

Deno.test("CRON_SECRET unset + wrong Bearer -> REJECTED", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: undefined,
      incomingCronSecret: null,
      authHeader: "Bearer not-the-service-role-key",
      serviceRoleKey: SERVICE_ROLE_KEY,
    }),
    false,
  );
});

Deno.test("CRON_SECRET unset + X-Cron-Secret header sent anyway -> REJECTED (no secret to match)", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: undefined,
      incomingCronSecret: "whatever",
      authHeader: "",
      serviceRoleKey: SERVICE_ROLE_KEY,
    }),
    false,
  );
});

Deno.test("CRON_SECRET unset + correct service-role Bearer -> AUTHORIZED (prod cron path always works)", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: undefined,
      incomingCronSecret: null,
      authHeader: `Bearer ${SERVICE_ROLE_KEY}`,
      serviceRoleKey: SERVICE_ROLE_KEY,
    }),
    true,
  );
});

// --- CRON_SECRET set (unchanged behavior, re-asserted) ---

Deno.test("CRON_SECRET set + no header at all -> REJECTED", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: "shh",
      incomingCronSecret: null,
      authHeader: "",
      serviceRoleKey: SERVICE_ROLE_KEY,
    }),
    false,
  );
});

Deno.test("CRON_SECRET set + anon-shaped Authorization header (no X-Cron-Secret) -> REJECTED", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: "shh",
      incomingCronSecret: null,
      authHeader: "Bearer some-anon-jwt-or-random-string",
      serviceRoleKey: SERVICE_ROLE_KEY,
    }),
    false,
  );
});

Deno.test("CRON_SECRET set + correct X-Cron-Secret header -> AUTHORIZED", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: "shh",
      incomingCronSecret: "shh",
      authHeader: "",
      serviceRoleKey: SERVICE_ROLE_KEY,
    }),
    true,
  );
});

Deno.test("CRON_SECRET set + correct service-role Bearer -> AUTHORIZED", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: "shh",
      incomingCronSecret: null,
      authHeader: `Bearer ${SERVICE_ROLE_KEY}`,
      serviceRoleKey: SERVICE_ROLE_KEY,
    }),
    true,
  );
});

Deno.test("CRON_SECRET set + wrong X-Cron-Secret -> REJECTED (401)", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: "shh",
      incomingCronSecret: "wrong",
      authHeader: "",
      serviceRoleKey: SERVICE_ROLE_KEY,
    }),
    false,
  );
});

Deno.test("CRON_SECRET set + wrong Bearer token -> REJECTED (401)", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: "shh",
      incomingCronSecret: null,
      authHeader: "Bearer not-the-service-role-key",
      serviceRoleKey: SERVICE_ROLE_KEY,
    }),
    false,
  );
});

Deno.test("CRON_SECRET set + non-Bearer Authorization header -> REJECTED", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: "shh",
      incomingCronSecret: null,
      authHeader: "Basic dXNlcjpwYXNz",
      serviceRoleKey: SERVICE_ROLE_KEY,
    }),
    false,
  );
});

Deno.test("empty serviceRoleKey never authorizes via Bearer, even if authHeader is 'Bearer ' (empty token)", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: undefined,
      incomingCronSecret: null,
      authHeader: "Bearer ",
      serviceRoleKey: "",
    }),
    false,
  );
});
