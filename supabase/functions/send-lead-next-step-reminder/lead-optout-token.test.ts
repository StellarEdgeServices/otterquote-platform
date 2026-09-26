// Deno unit tests for gh-2121 lead opt-out token sign/verify.
// Run: deno test supabase/functions/send-lead-next-step-reminder/lead-optout-token.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  buildLeadOptOutUrl,
  signLeadOptOutToken,
  verifyLeadOptOutToken,
} from "./lead-optout-token.ts";

Deno.test("round-trips a lead id through sign/verify", async () => {
  const token = await signLeadOptOutToken("lead-abc", "secret1");
  const out = await verifyLeadOptOutToken(token, ["secret1"]);
  assertEquals(out, "lead-abc");
});

Deno.test("rejects a token signed with a different secret", async () => {
  const token = await signLeadOptOutToken("lead-abc", "secret1");
  const out = await verifyLeadOptOutToken(token, ["other-secret"]);
  assertEquals(out, null);
});

Deno.test("verifies against a list of secrets (rotation)", async () => {
  const token = await signLeadOptOutToken("lead-abc", "old-secret");
  const out = await verifyLeadOptOutToken(token, ["new-secret", "old-secret"]);
  assertEquals(out, "lead-abc");
});

Deno.test("rejects malformed tokens without throwing", async () => {
  assertEquals(await verifyLeadOptOutToken("garbage", ["secret1"]), null);
  assertEquals(await verifyLeadOptOutToken("", ["secret1"]), null);
  assertEquals(await verifyLeadOptOutToken(null, ["secret1"]), null);
  assertEquals(await verifyLeadOptOutToken("a.b.c", ["secret1"]), null);
});

Deno.test("a token cannot be forged by tampering the payload", async () => {
  const token = await signLeadOptOutToken("lead-abc", "secret1");
  const [, sig] = token.split(".");
  const forged = `${btoa("lead-different-id").replace(/=+$/, "")}.${sig}`;
  assertEquals(await verifyLeadOptOutToken(forged, ["secret1"]), null);
});

Deno.test("buildLeadOptOutUrl points at the lead-next-step-optout function", () => {
  const url = buildLeadOptOutUrl("https://x.supabase.co/functions/v1/", "abc.def");
  assertEquals(url, "https://x.supabase.co/functions/v1/lead-next-step-optout?t=abc.def");
});
