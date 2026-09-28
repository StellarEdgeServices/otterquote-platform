// Deno unit test for gh-1824 footer-batch-3: mark-job-complete's rendered
// homeowner-notification email must carry the D-237 postal address.
// Run: deno test supabase/functions/mark-job-complete/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { jobCompleteEmailText, jobCompleteEmailHtml } from "./templates.ts";
import { POSTAL_ADDRESS, footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts";

Deno.test("gh-1824 mark-job-complete: jobCompleteEmailText includes the D-237 postal address", () => {
  assertEquals(
    jobCompleteEmailText("Jane", "Acme Roofing", "123 Main St", "Monday, January 1, 2026").includes(POSTAL_ADDRESS),
    true,
  );
});

Deno.test("gh-1824 mark-job-complete: jobCompleteEmailHtml includes the D-237 postal address", () => {
  assertEquals(
    jobCompleteEmailHtml("Jane", "Acme Roofing", "123 Main St", "Monday, January 1, 2026").includes(POSTAL_ADDRESS),
    true,
  );
});

// REVIEW FAIL 5870472283 nit: footerPostalAddressHtml() returns a <div>,
// which must never land nested inside a <p> (invalid nesting -- browsers
// close the <p> early and the link loses the footer's styling context).
// Guard it directly so a future refactor can't silently reintroduce the
// nesting.
Deno.test("gh-1824 mark-job-complete: jobCompleteEmailHtml never nests footerPostalAddressHtml()'s <div> inside a <p>", () => {
  const html = jobCompleteEmailHtml("Jane", "Acme Roofing", "123 Main St", "Monday, January 1, 2026");
  const footerDiv = footerPostalAddressHtml();
  // A <div> immediately preceded (with only whitespace/attributes between)
  // by an unclosed "<p ...>" would indicate the nesting bug. Assert instead
  // that every "<p" opening tag up to the next ">" is closed by "</p>"
  // before the footer div's own opening "<div" appears -- i.e. the div is
  // never inside an open <p>.
  const divIndex = html.indexOf(footerDiv);
  assertEquals(divIndex > -1, true);
  const before = html.slice(0, divIndex);
  const lastOpenP = before.lastIndexOf("<p");
  const lastCloseP = before.lastIndexOf("</p>");
  // If a <p> opened more recently than the last </p>, the div would land inside it.
  assertEquals(lastOpenP > lastCloseP, false);
});

// =============================================================================
// REVIEW FAIL 5870472283 must-fix: exact-equality goldens for fixed inputs.
//
// Independent copy of the pre-extraction wording from origin/main's
// mark-job-complete/index.ts, reproduced here as a plain literal with the
// D-237 footer wired in exactly as this PR's change does (including the
// REVIEW FAIL 5870472283 nit fix: the footer's <div> now sits outside the
// trailing <p>, not nested inside it). If templates.ts's wording drifts,
// this golden still carries the original wording and assertEquals fails.
// Manually verified by mutating templates.ts and re-running -- see PR/issue
// comments.
// =============================================================================

const HOMEOWNER_NAME = "Jane Homeowner";
const CONTRACTOR_NAME = "Acme Roofing & Restoration";
const ADDRESS = "123 Main St, Indianapolis, IN";
const FORMATTED_DATE = "Monday, January 1, 2026";

Deno.test("gh-1824 mark-job-complete: jobCompleteEmailText exact-pins the full rendered body for fixed inputs", () => {
  const golden = [
    `Hi ${HOMEOWNER_NAME},`,
    "",
    `${CONTRACTOR_NAME} has marked the job at ${ADDRESS} as complete as of ${FORMATTED_DATE}.`,
    "",
    "If the work is finished to your satisfaction, no action is needed. If you have any concerns or believe the job is not yet complete, please log in to your Otter Quotes account and reach out through your project dashboard.",
    "",
    "Log in to review: https://app.otterquote.com",
    "",
    "Thank you for using Otter Quotes.",
    "— The Otter Quotes Team",
    "",
    footerPostalAddressText(),
  ].join("\n");
  assertEquals(jobCompleteEmailText(HOMEOWNER_NAME, CONTRACTOR_NAME, ADDRESS, FORMATTED_DATE), golden);
});

Deno.test("gh-1824 mark-job-complete: jobCompleteEmailHtml exact-pins the full rendered body for fixed inputs", () => {
  const golden = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1F2937;">
  <div style="text-align:center;margin-bottom:2rem;">
    <img src="https://otterquote.com/images/otter-logo.png" alt="Otter Quotes" style="height:48px;" onerror="this.style.display='none'">
  </div>
  <h2 style="color:#0D1B2E;margin-bottom:1rem;">Job Marked Complete</h2>
  <p>Hi ${HOMEOWNER_NAME},</p>
  <p><strong>${CONTRACTOR_NAME}</strong> has marked the job at <strong>${ADDRESS}</strong> as complete as of <strong>${FORMATTED_DATE}</strong>.</p>
  <p>If the work is finished to your satisfaction, no action is needed. If you have any concerns or believe the job is not yet complete, please log in to your Otter Quotes account and reach out through your project dashboard.</p>
  <div style="text-align:center;margin:2rem 0;">
    <a href="https://app.otterquote.com" style="background:#E07B00;color:#fff;padding:0.75rem 1.5rem;border-radius:0.5rem;text-decoration:none;font-weight:600;">Review Your Project</a>
  </div>
  <p style="color:#6B7280;font-size:0.875rem;">Thank you for using Otter Quotes.</p>
  <hr style="border:none;border-top:1px solid #E2E8F0;margin:1.5rem 0;">
  <div style="color:#9CA3AF;font-size:0.75rem;text-align:center;">${footerPostalAddressHtml()}</div>
  <p style="color:#9CA3AF;font-size:0.75rem;text-align:center;"><a href="https://otterquote.com" style="color:#9CA3AF;">otterquote.com</a></p>
</body>
</html>`;
  assertEquals(jobCompleteEmailHtml(HOMEOWNER_NAME, CONTRACTOR_NAME, ADDRESS, FORMATTED_DATE), golden);
});
