// Deno unit test for gh-1824 footer-batch-6 (docusign-webhook): pins every rendered email body
// with exact-equality goldens (REVIEW: FAIL 5881354201 on PR #2331; same bar as
// batches 2-5, HOLD 5870481359 / FAIL 5870472283). A `.includes(POSTAL_ADDRESS)`-only
// test lets a one-word change to the body ship undetected, so each golden below is
// the FULL rendered text or HTML. Every golden was captured by executing the
// ORIGINAL, pre-extraction code (verbatim slices of index.ts at fd6255c1) with the
// fixed inputs used here, BEFORE the bodies were moved into templates.ts, so the
// goldens prove the extraction changed no byte. The D-237 footer is part of each builder's output here.
// Run: deno test --no-check -A supabase/functions/docusign-webhook/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  counterSignNudgeHtml,
  counterSignNudgeText,
  homeownerContractSignedHtml,
  homeownerContractSignedText,
} from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

const NUDGE: [string, string, string, string] = ["Pat Contractor", "123 Main St, Indianapolis, IN 46220", "Job #ABCD1234", "https://otterquote.com/contractor-dashboard.html"];
const HCS: [string, string, string, string, string] = ["Jordan Homeowner", "Acme Roofing & Gutters", "456 Oak Ave, Carmel, IN 46032", "Job #EFGH5678", "https://otterquote.com/dashboard.html"];

Deno.test("gh-1824 docusign-webhook: D-149 counter-sign nudge TEXT matches the pinned golden", () => {
  assertEquals(counterSignNudgeText(...NUDGE), "Hi Pat Contractor,\n\nGood news — the homeowner has signed the contract for 123 Main St, Indianapolis, IN 46220 (Job #ABCD1234).\n\nThe contract is now waiting on your counter-signature. Once you sign, the agreement is fully executed and the project can move forward.\n\nCounter-sign from your dashboard:\nhttps://otterquote.com/contractor-dashboard.html\n\nWe'll send you a reminder every couple of hours during business hours until the contract is fully executed.\n\nQuestions? Reply to this email or call (844) 875-3412.\n\n— The Otter Quotes Team\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 docusign-webhook: D-149 counter-sign nudge HTML matches the pinned golden", () => {
  assertEquals(counterSignNudgeHtml(...NUDGE), "<!DOCTYPE html><html><body style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;\"><p>Hi Pat Contractor,</p><p>Good news — the homeowner has signed the contract for <strong>123 Main St, Indianapolis, IN 46220</strong> (Job #ABCD1234).</p><p>The contract is now waiting on <strong>your counter-signature</strong>. Once you sign, the agreement is fully executed and the project can move forward.</p><p><a href=\"https://otterquote.com/contractor-dashboard.html\" style=\"color:#0066cc;\">Counter-sign from your dashboard</a></p><p>We'll send you a reminder every couple of hours during business hours until the contract is fully executed.</p><p>Questions? Reply to this email or call (844) 875-3412.</p><p>— The Otter Quotes Team</p><div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div></body></html>");
});

Deno.test("gh-1824 docusign-webhook: homeowner contract-signed TEXT matches the pinned golden", () => {
  assertEquals(homeownerContractSignedText(...HCS), "Hi Jordan Homeowner,\n\nGreat news — your contract with Acme Roofing & Gutters for 456 Oak Ave, Carmel, IN 46032 is fully executed.\n\nJob #EFGH5678\n\nWhat happens next:\n• Acme Roofing & Gutters will contact you within 48 hours to coordinate next steps.\n• You can track your project status anytime on your dashboard: https://otterquote.com/dashboard.html\n\nQuestions? Reply to this email or contact support@otterquote.com.\n\n— The Otter Quotes Team\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 docusign-webhook: homeowner contract-signed HTML matches the pinned golden", () => {
  assertEquals(homeownerContractSignedHtml(...HCS), "<!DOCTYPE html><html><body style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;\"><p>Hi Jordan Homeowner,</p><p>Great news — your contract with <strong>Acme Roofing & Gutters</strong> for <strong>456 Oak Ave, Carmel, IN 46032</strong> is fully executed.</p><p style=\"font-size:1.05rem;font-weight:bold;color:#0066cc;\">Job #EFGH5678</p><p><strong>What happens next:</strong></p><ul><li>Acme Roofing & Gutters will contact you within 48 hours to coordinate next steps.</li><li>You can track your project status anytime on your <a href=\"https://otterquote.com/dashboard.html\" style=\"color:#0066cc;\">dashboard</a>.</li></ul><p>Questions? Reply to this email or contact <a href=\"mailto:support@otterquote.com\">support@otterquote.com</a>.</p><p>— The Otter Quotes Team</p><div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div></body></html>");
});

Deno.test("gh-1824 docusign-webhook: goldens still contain the D-237 postal address (sanity check on the goldens themselves)", () => {
  for (const body of [counterSignNudgeText(...NUDGE), counterSignNudgeHtml(...NUDGE), homeownerContractSignedText(...HCS), homeownerContractSignedHtml(...HCS)]) {
    assertEquals(body.includes(POSTAL_ADDRESS), true);
  }
});
