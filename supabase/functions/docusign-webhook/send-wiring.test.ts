// Source-level wiring test for gh-1824 footer-batch-6 (docusign-webhook).
// index.ts calls serve() at import time, so it cannot be imported by a unit test. This test
// reads index.ts as text (comments stripped) and asserts the send site is still wired:
// both Mailgun sends must be fed by the templates.ts builders (which carry the footer).
// templates.test.ts pins the rendered bodies; this pins that index.ts still uses them (REVIEW:
// FAIL 5881354201 on PR #2331: the suite stayed green with the send site unwired).
// Run: deno test --no-check -A supabase/functions/docusign-webhook/send-wiring.test.ts

import { assertMatch } from "https://deno.land/std@0.177.0/testing/asserts.ts";

async function indexSource(): Promise<string> {
  const raw = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

Deno.test("gh-1824 docusign-webhook send-wiring: D-149 nudge send uses the templates.ts builders", async () => {
  assertMatch(await indexSource(), /const nudgeText = counterSignNudgeText\([^)]*\);\s*const nudgeHtml = counterSignNudgeHtml\([^)]*\);[\s\S]*fd\.append\("text", nudgeText\);\s*fd\.append\("html", nudgeHtml\);/);
});

Deno.test("gh-1824 docusign-webhook send-wiring: homeowner contract-signed send uses the templates.ts builders", async () => {
  assertMatch(await indexSource(), /const textBody = homeownerContractSignedText\([^)]*\);\s*const htmlBody = homeownerContractSignedHtml\([^)]*\);[\s\S]*fd\.append\("text", textBody\);\s*fd\.append\("html", htmlBody\);/);
});
