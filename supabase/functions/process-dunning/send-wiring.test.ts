// Source-level wiring test for gh-1824 footer-batch-6 (process-dunning).
// index.ts calls serve() at import time, so it cannot be imported by a unit test. This test
// reads index.ts as text (comments stripped) and asserts the send site is still wired:
// sendEmail() must wrap both parts with the footer helpers, and every email must be built by templates.ts.
// templates.test.ts pins the rendered bodies; this pins that index.ts still uses them (REVIEW:
// FAIL 5881354201 on PR #2331: the suite stayed green with the send site unwired).
// Run: deno test --no-check -A supabase/functions/process-dunning/send-wiring.test.ts

import { assertMatch } from "https://deno.land/std@0.177.0/testing/asserts.ts";

async function indexSource(): Promise<string> {
  const raw = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

Deno.test("gh-1824 process-dunning send-wiring: sendEmail wraps the text part with appendPostalFooterText", async () => {
  assertMatch(await indexSource(), /body\.append\(\s*"text"\s*,\s*appendPostalFooterText\(\s*text \|\| htmlToPlainText\(html\)\s*\)\s*\)/);
});

Deno.test("gh-1824 process-dunning send-wiring: sendEmail wraps the html part with appendPostalFooterHtml", async () => {
  assertMatch(await indexSource(), /body\.append\(\s*"html"\s*,\s*appendPostalFooterHtml\(\s*html\s*\)\s*\)/);
});

Deno.test("gh-1824 process-dunning send-wiring: contractor reminder emails are built by templates.ts", async () => {
  assertMatch(await indexSource(), /hourlyReminderEmail\(companyName\)[\s\S]*warningEmail\(companyName\)/);
});

Deno.test("gh-1824 process-dunning send-wiring: homeowner choice email is built by templates.ts", async () => {
  assertMatch(await indexSource(), /homeownerNotificationEmail\(homeownerName, companyName, failure\.id, supabaseUrl\)/);
});

Deno.test("gh-1824 process-dunning send-wiring: contractor outcome emails are built by templates.ts", async () => {
  assertMatch(await indexSource(), /contractorProceedEmail\(companyName\)[\s\S]*contractorLostProjectEmail\(companyName\)/);
});

Deno.test("gh-1824 process-dunning send-wiring: admin alerts are built by templates.ts", async () => {
  assertMatch(await indexSource(), /proceededAdminAlertEmail\([^)]*\)[\s\S]*differentContractorAdminAlertEmail\([^)]*\)[\s\S]*homeownerNotifiedAdminAlertEmail\([^)]*\)/);
});
