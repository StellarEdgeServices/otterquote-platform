// Deno unit test for gh-1824 footer-batch-2: send-bid-confirmation's
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/send-bid-confirmation/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildEmailHtml, buildEmailText } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

const ARGS: [string, string, string, string, number, number, number] = [
  "Jane",
  "Job #12345678",
  "claim-abc-123",
  "Roofing",
  5000,
  10,
  500,
];

Deno.test("gh-1824 send-bid-confirmation: buildEmailHtml includes the D-237 postal address", () => {
  const html = buildEmailHtml(...ARGS);
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 send-bid-confirmation: buildEmailText includes the D-237 postal address", () => {
  const text = buildEmailText(...ARGS);
  assertEquals(text.includes(POSTAL_ADDRESS), true);
});
