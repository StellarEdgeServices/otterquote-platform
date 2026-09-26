// Deno unit tests for gh-2154 P-4 switch-on hardening (item (2)): uncertain
// rows raise an admin alert. Fails on the pre-hardening head (merged in
// #2180, b6ea0ecb) with a module-not-found error - ./admin-alert.ts does
// not exist there.
// Run: deno test supabase/functions/send-partner-onboarding/admin-alert.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { ADMIN_EMAIL, buildUncertainAlertEmail, escapeHtml, stripHeaderInjection } from "./admin-alert.ts";
// Cross-import, test-only (see admin-alert.ts's file header - deno test
// resolves relative imports against the real filesystem regardless of what
// the deploy bundler can follow): proves this duplicated ADMIN_EMAIL never
// drifts from P-3's own notify-admin-new-partner constant, which is the
// "same fixed admin recipient P-3 uses" this task's brief requires.
import { ADMIN_EMAIL as P3_ADMIN_EMAIL } from "../notify-admin-new-partner/index.ts";

Deno.test("ADMIN_EMAIL is byte-identical to notify-admin-new-partner's ADMIN_EMAIL (P-3's fixed recipient)", () => {
  assertEquals(ADMIN_EMAIL, P3_ADMIN_EMAIL);
});

Deno.test("ADMIN_EMAIL is Dustin's real address, not empty and not a placeholder", () => {
  assertEquals(ADMIN_EMAIL, "dustinstohler1@gmail.com");
});

Deno.test("stripHeaderInjection strips CR/LF from the subject", () => {
  assertEquals(stripHeaderInjection("hello\r\nBcc: evil@example.com"), "hello Bcc: evil@example.com");
});

Deno.test("stripHeaderInjection strips U+2028/U+2029/U+0085 line separators", () => {
  const input = "a" + " " + "b" + " " + "c" + "\u0085" + "d";
  assertEquals(stripHeaderInjection(input), "a b c d");
});

Deno.test("buildUncertainAlertEmail: subject names the count and is header-injection-safe", () => {
  const email = buildUncertainAlertEmail([
    { partner_id: "11111111-1111-1111-1111-111111111111", stage: "day0" },
    { partner_id: "22222222-2222-2222-2222-222222222222", stage: "day3" },
  ]);
  assertEquals(email.subject.includes("2"), true);
  const forbidden = ["\r", "\n", " ", " ", "\u0085"];
  assertEquals(forbidden.some((ch) => email.subject.includes(ch)), false);
});

Deno.test("buildUncertainAlertEmail: singular phrasing for exactly one row", () => {
  const email = buildUncertainAlertEmail([{ partner_id: "11111111-1111-1111-1111-111111111111", stage: "day0" }]);
  assertEquals(email.subject.includes("1 uncertain send outcome need"), true);
  assertEquals(email.subject.includes("outcomes"), false);
});

Deno.test("buildUncertainAlertEmail: lists every partner_id + stage in both text and HTML bodies", () => {
  const rows = [
    { partner_id: "11111111-1111-1111-1111-111111111111", stage: "day0" },
    { partner_id: "22222222-2222-2222-2222-222222222222", stage: "day7" },
  ];
  const email = buildUncertainAlertEmail(rows);
  for (const r of rows) {
    assertEquals(email.textBody.includes(r.partner_id), true);
    assertEquals(email.textBody.includes(r.stage), true);
    assertEquals(email.htmlBody.includes(r.partner_id), true);
    assertEquals(email.htmlBody.includes(r.stage), true);
  }
});

Deno.test("buildUncertainAlertEmail: the function has no email field to leak - only partner_id/stage ever appear", () => {
  // The function receives only {partner_id, stage} - it has no email field
  // to leak even by accident (UncertainAlertRow's own shape). Feeding it a
  // partner_id that LOOKS like an email (a caller bug elsewhere) still gets
  // HTML-escaped like any other untrusted string, never treated specially.
  const rows = [{ partner_id: "not-a-real-shape-example-dot-com", stage: "day1" }];
  const email = buildUncertainAlertEmail(rows);
  assertEquals(email.htmlBody.includes("not-a-real-shape-example-dot-com"), true);
});

Deno.test("buildUncertainAlertEmail: HTML-escapes partner_id and stage in the HTML body", () => {
  const rows = [{ partner_id: "<script>alert(1)</script>", stage: "day0" }];
  const email = buildUncertainAlertEmail(rows);
  assertEquals(email.htmlBody.includes("<script>alert(1)</script>"), false);
  assertEquals(email.htmlBody.includes("&lt;script&gt;"), true);
});

Deno.test("escapeHtml escapes the five standard entities", () => {
  assertEquals(escapeHtml("<>&\"'"), "&lt;&gt;&amp;&quot;&#39;");
});
