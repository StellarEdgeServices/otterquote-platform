// Deno unit test for gh-1824 footer-batch-3: check-rate-limits' rendered
// alert email must carry the D-237 postal address.
// Run: deno test supabase/functions/check-rate-limits/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { rateLimitAlertText } from "./templates.ts";
import { POSTAL_ADDRESS, footerPostalAddressText } from "./email-footer.ts";

Deno.test("gh-1824 check-rate-limits: rateLimitAlertText includes the D-237 postal address", () => {
  assertEquals(rateLimitAlertText("send-sms", 720, 1000, 72).includes(POSTAL_ADDRESS), true);
});

// =============================================================================
// REVIEW FAIL 5870472283 must-fix: exact-equality golden for fixed inputs.
//
// Independent copy of the pre-extraction wording from origin/main's
// check-rate-limits/index.ts, reproduced here as a plain literal with the
// footer line appended exactly as this PR's change does. If templates.ts's
// wording drifts, this golden still carries the original wording and
// assertEquals fails. Manually verified by mutating templates.ts and
// re-running -- see PR/issue comments.
// =============================================================================

Deno.test("gh-1824 check-rate-limits: rateLimitAlertText exact-pins the full rendered body for fixed inputs", () => {
  const golden = `
Function: send-sms
Current Usage: 720 calls
Monthly Limit: 1000 calls
Usage: 72%

Recommendation: Review usage patterns and consider optimization or plan for increased capacity.

This is an automated alert from OtterQuote monitoring.

${footerPostalAddressText()}
            `.trim();
  assertEquals(rateLimitAlertText("send-sms", 720, 1000, 72), golden);
});
