// gh-2154 P-5 go-live (item 2, "treat uncertain outcomes the way P-4
// does after #2191") — admin-alert.ts duplicate tests, same shape as
// send-partner-onboarding/admin-alert.test.ts.
// Run: deno test --allow-read=supabase/functions supabase/functions/send-partner-invite-reminder/admin-alert.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { ADMIN_EMAIL, buildUncertainAlertEmail, escapeHtml, stripHeaderInjection } from "./admin-alert.ts";
// Cross-import, test-only (deno test resolves relative imports against the
// real filesystem, unlike the deploy bundler): proves this THIRD copy of
// ADMIN_EMAIL never drifts from P-3's own constant either.
import { ADMIN_EMAIL as P3_ADMIN_EMAIL } from "../notify-admin-new-partner/index.ts";

Deno.test("ADMIN_EMAIL is byte-identical to notify-admin-new-partner's ADMIN_EMAIL (P-3's fixed recipient)", () => {
  assertEquals(ADMIN_EMAIL, P3_ADMIN_EMAIL);
});

Deno.test("stripHeaderInjection strips CR/LF from the subject", () => {
  assertEquals(stripHeaderInjection("hello\r\nBcc: evil@example.com"), "hello Bcc: evil@example.com");
});

Deno.test("buildUncertainAlertEmail: lists the invite_reminder stage for an uncertain row", () => {
  const email = buildUncertainAlertEmail([{ partner_id: "11111111-1111-1111-1111-111111111111", stage: "invite_reminder" }]);
  assertEquals(email.textBody.includes("invite_reminder"), true);
  assertEquals(email.htmlBody.includes("invite_reminder"), true);
});

Deno.test("escapeHtml escapes the five standard entities", () => {
  assertEquals(escapeHtml("<>&\"'"), "&lt;&gt;&amp;&quot;&#39;");
});
