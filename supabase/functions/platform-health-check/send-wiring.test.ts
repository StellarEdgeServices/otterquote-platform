// Source-level wiring test for gh-1824 footer-batch-6 (platform-health-check).
// index.ts calls serve() at import time, so it cannot be imported by a unit test. This test
// reads index.ts as text (comments stripped) and asserts the send site is still wired:
// sendMailgunAlert() must build the text part with alertEmailText (body + footer), and every alert must be built by templates.ts.
// templates.test.ts pins the rendered bodies; this pins that index.ts still uses them (REVIEW:
// FAIL 5881354201 on PR #2331: the suite stayed green with the send site unwired).
// Run: deno test --no-check -A supabase/functions/platform-health-check/send-wiring.test.ts

import { assertMatch } from "https://deno.land/std@0.177.0/testing/asserts.ts";

async function indexSource(): Promise<string> {
  const raw = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

Deno.test("gh-1824 platform-health-check send-wiring: sendMailgunAlert builds the text part with alertEmailText", async () => {
  assertMatch(await indexSource(), /formData\.append\(\s*"text"\s*,\s*alertEmailText\(\s*body\s*\)\s*\)/);
});

Deno.test("gh-1824 platform-health-check send-wiring: EF, cron and public-path alerts are built by templates.ts", async () => {
  assertMatch(await indexSource(), /efSilentFailureAlert\(result, [^)]*\)[\s\S]*cronErrorAlert\([^)]*\)[\s\S]*cronStalenessAlert\([^)]*\)[\s\S]*publicPathFailureAlert\(result, [^)]*\)/);
});

Deno.test("gh-1824 platform-health-check send-wiring: SMS and register_partner alerts are built by templates.ts", async () => {
  assertMatch(await indexSource(), /smsUndeliveredAlert\([^)]*\)[\s\S]*registerPartnerBudgetMessage\(alert\.message, [^)]*\)/);
});
