// Source-level wiring test for gh-1824 footer-batch-6 (notify-admin-new-homeowner).
// index.ts calls serve() at import time, so it cannot be imported by a unit test. This test
// reads index.ts as text (comments stripped) and asserts the send site is still wired:
// sendMail() must wrap both parts with the footer helpers, and every alert must be built by templates.ts.
// templates.test.ts pins the rendered bodies; this pins that index.ts still uses them (REVIEW:
// FAIL 5881354201 on PR #2331: the suite stayed green with the send site unwired).
// Run: deno test --no-check -A supabase/functions/notify-admin-new-homeowner/send-wiring.test.ts

import { assertMatch } from "https://deno.land/std@0.177.0/testing/asserts.ts";

async function indexSource(): Promise<string> {
  const raw = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

Deno.test("gh-1824 notify-admin-new-homeowner send-wiring: sendMail wraps the text part with appendPostalFooterText", async () => {
  assertMatch(await indexSource(), /formData\.append\(\s*"text"\s*,\s*appendPostalFooterText\(\s*textBody\s*\)\s*\)/);
});

Deno.test("gh-1824 notify-admin-new-homeowner send-wiring: sendMail wraps the html part with appendPostalFooterHtml", async () => {
  assertMatch(await indexSource(), /formData\.append\(\s*"html"\s*,\s*appendPostalFooterHtml\(\s*htmlBody\s*\)\s*\)/);
});

Deno.test("gh-1824 notify-admin-new-homeowner send-wiring: new-claim alert is built by templates.ts", async () => {
  assertMatch(await indexSource(), /newClaimText\([^)]*\)[\s\S]*newClaimHtml\([^)]*\)/);
});

Deno.test("gh-1824 notify-admin-new-homeowner send-wiring: backlog digest is built by templates.ts", async () => {
  assertMatch(await indexSource(), /backlogDigestText\(toAlert\)[\s\S]*backlogDigestHtml\(toAlert\)/);
});

Deno.test("gh-1824 notify-admin-new-homeowner send-wiring: backfill digest is built by templates.ts", async () => {
  assertMatch(await indexSource(), /backfillDigestText\(toAlert\)[\s\S]*backfillDigestHtml\(toAlert\)/);
});

Deno.test("gh-1824 notify-admin-new-homeowner send-wiring: individual signup alert is built by templates.ts", async () => {
  assertMatch(await indexSource(), /newHomeownerText\(p\)[\s\S]*newHomeownerHtml\(p\)/);
});

Deno.test("gh-1824 notify-admin-new-homeowner send-wiring: router-lead HTML is built by templates.ts", async () => {
  assertMatch(await indexSource(), /routerLeadHtml\(htmlRows, extraHtml\)/);
});
