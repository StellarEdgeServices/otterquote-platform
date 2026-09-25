// Deno unit tests for gh-2121 fix round 1, must-fix 3 (CEO RUN 68 REVIEW:
// FAIL, comment 5825698253): send-lead-next-step-reminder had NO auth gate
// at all before this fix. These fail against head 0a4988fe with a
// module-not-found error (cron-auth.ts does not exist yet).
// Run: deno test supabase/functions/send-lead-next-step-reminder/cron-auth.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { isCronAuthorized } from "./cron-auth.ts";

const SERVICE_ROLE_KEY = "srv-role-key-abc123";

Deno.test("no CRON_SECRET configured — permissive (dev/staging), matches send-homeowner-next-steps", () => {
  assertEquals(
    isCronAuthorized({
      cronSecret: undefined,
      incomingCronSecret: null,
      authHeader: "",
      serviceRoleKey: SERVICE_ROLE_KEY,
    }),
    true,
  );
});

Deno.test("correct X-Cron-Secret header authorizes", () => {
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

Deno.test("correct service-role Bearer token authorizes", () => {
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

Deno.test("wrong X-Cron-Secret is rejected (401)", () => {
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

Deno.test("wrong Bearer token is rejected (401)", () => {
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

Deno.test("no auth header at all is rejected when CRON_SECRET is configured", () => {
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

Deno.test("a non-Bearer Authorization header is rejected", () => {
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
