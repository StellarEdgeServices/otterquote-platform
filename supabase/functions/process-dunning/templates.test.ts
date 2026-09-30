// Deno unit test for gh-1824 footer-batch-6 (process-dunning): pins every rendered email body
// with exact-equality goldens (REVIEW: FAIL 5881354201 on PR #2331; same bar as
// batches 2-5, HOLD 5870481359 / FAIL 5870472283). A `.includes(POSTAL_ADDRESS)`-only
// test lets a one-word change to the body ship undetected, so each golden below is
// the FULL rendered text or HTML. Every golden was captured by executing the
// ORIGINAL, pre-extraction code (verbatim slices of index.ts at fd6255c1) with the
// fixed inputs used here, BEFORE the bodies were moved into templates.ts, so the
// goldens prove the extraction changed no byte. Goldens are the bodies as SENT by sendEmail(): builder HTML -> appendPostalFooterHtml, and htmlToPlainText(html) -> appendPostalFooterText for the text part.
// Run: deno test --no-check -A supabase/functions/process-dunning/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { appendPostalFooterHtml, appendPostalFooterText } from "./footer-append.ts";
import {
  adminAlertEmail,
  contractorLostProjectEmail,
  contractorProceedEmail,
  differentContractorAdminAlertEmail,
  homeownerNotificationEmail,
  homeownerNotifiedAdminAlertEmail,
  hourlyReminderEmail,
  htmlToPlainText,
  proceededAdminAlertEmail,
  warningEmail,
} from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

// Same composition as sendEmail() in index.ts when the caller passes no `text`.
const sentHtml = (html: string) => appendPostalFooterHtml(html);
const sentText = (html: string) => appendPostalFooterText(htmlToPlainText(html));
const CO = "Acme Roofing & Sons";
const HOMEOWNER = () => homeownerNotificationEmail("Pat Homeowner", CO, "fail-123", "https://yeszghaspzwwstvsrioa.supabase.co");

Deno.test("gh-1824 process-dunning: hourly payment-declined reminder HTML as sent matches the pinned golden", () => {
  assertEquals(sentHtml(hourlyReminderEmail(CO)), "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;\">\n  <div style=\"background:#0B1929;padding:20px;border-radius:8px 8px 0 0;text-align:center;\">\n    <img src=\"https://otterquote.com/img/otter-logo.svg\" alt=\"Otter Quotes\" style=\"width:40px;height:40px;\">\n    <h1 style=\"color:#F59E0B;font-size:18px;margin:10px 0 0;\">Payment Action Required</h1>\n  </div>\n  <div style=\"background:#ffffff;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px;\">\n    <p>Hi Acme Roofing & Sons,</p>\n     <p>You have a signed contract waiting for you, but your payment method has been declined.\n     Please <a href=\"https://otterquote.com/contractor-settings.html\" style=\"color:#0369A1;font-weight:600;\">click here</a> to resolve the matter.</p>\n     <a href=\"https://otterquote.com/contractor-settings.html\"\n        style=\"display:inline-block;background:#F59E0B;color:#0B1929;padding:12px 24px;\n               border-radius:6px;text-decoration:none;font-weight:600;margin-top:12px;\">\n       Update Payment Method\n     </a>\n    <p style=\"color:#6B7280;font-size:13px;margin-top:20px;\">Questions? Contact us at support@otterquote.com</p>\n  </div>\n</div><div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>");
});

Deno.test("gh-1824 process-dunning: hourly payment-declined reminder TEXT as sent matches the pinned golden", () => {
  assertEquals(sentText(hourlyReminderEmail(CO)), "Payment Action Required\n\nHi Acme Roofing & Sons,\n\nYou have a signed contract waiting for you, but your payment method has been declined.\nPlease click here: https://otterquote.com/contractor-settings.html to resolve the matter.\n\nUpdate Payment Method: https://otterquote.com/contractor-settings.html\nQuestions? Contact us at support@otterquote.com\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 process-dunning: final-notice warning email HTML as sent matches the pinned golden", () => {
  assertEquals(sentHtml(warningEmail(CO)), "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;\">\n  <div style=\"background:#7F1D1D;padding:20px;border-radius:8px 8px 0 0;text-align:center;\">\n    <img src=\"https://otterquote.com/img/otter-logo.svg\" alt=\"Otter Quotes\" style=\"width:40px;height:40px;\">\n    <h1 style=\"color:#FCA5A5;font-size:18px;margin:10px 0 0;\">Final Notice — Payment Declined</h1>\n  </div>\n  <div style=\"background:#ffffff;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px;\">\n    <p>Hi Acme Roofing & Sons,</p>\n     <p>You have a signed contract waiting for you, but your payment method has been declined.</p>\n     <div style=\"background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:16px;margin:16px 0;\">\n       <p style=\"color:#991B1B;font-weight:600;margin:0 0 8px;\">What happens at 10 a.m. today:</p>\n       <p style=\"color:#7F1D1D;margin:0;\">\n         We will inform the client of the payment failure and give them the option to choose\n         another contractor. If they opt to move forward with you, you will receive their\n         information and be liable for all fees, a $250 nonpayment fee, and any attorney's\n         fees and costs associated with collecting this amount.\n       </p>\n     </div>\n     <a href=\"https://otterquote.com/contractor-settings.html\"\n        style=\"display:inline-block;background:#DC2626;color:#ffffff;padding:12px 24px;\n               border-radius:6px;text-decoration:none;font-weight:600;margin-top:8px;\">\n       Resolve Now — Update Payment Method\n     </a>\n    <p style=\"color:#6B7280;font-size:13px;margin-top:20px;\">Questions? Contact us at support@otterquote.com</p>\n  </div>\n</div><div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>");
});

Deno.test("gh-1824 process-dunning: final-notice warning email TEXT as sent matches the pinned golden", () => {
  assertEquals(sentText(warningEmail(CO)), "Final Notice — Payment Declined\n\nHi Acme Roofing & Sons,\n\nYou have a signed contract waiting for you, but your payment method has been declined.\n\nWhat happens at 10 a.m. today:\n\nWe will inform the client of the payment failure and give them the option to choose\nanother contractor. If they opt to move forward with you, you will receive their\ninformation and be liable for all fees, a $250 nonpayment fee, and any attorney's\nfees and costs associated with collecting this amount.\n\nResolve Now — Update Payment Method: https://otterquote.com/contractor-settings.html\nQuestions? Contact us at support@otterquote.com\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 process-dunning: homeowner choice email HTML as sent matches the pinned golden", () => {
  assertEquals(sentHtml(HOMEOWNER()), "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;\">\n  <div style=\"background:#0B1929;padding:20px;border-radius:8px 8px 0 0;text-align:center;\">\n    <img src=\"https://otterquote.com/img/otter-logo.svg\" alt=\"Otter Quotes\" style=\"width:40px;height:40px;\">\n    <h1 style=\"color:#14B8A6;font-size:18px;margin:10px 0 0;\">Important Update on Your Project</h1>\n  </div>\n  <div style=\"background:#ffffff;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px;\">\n    <p>Hi Pat Homeowner,</p>\n     <p>The payment method your contractor has on file with us has been declined.\n     Contractors typically charge thousands of dollars to their credit cards for materials\n     every day. So this is probably just an oversight on their part. But there is a small\n     chance that this could be a sign of financial concerns. We have not sent your contact\n     information to this contractor.</p>\n     <p>At this time, you have the option to move forward with the contractor you have\n     selected or select another contractor for your project.</p>\n     <div style=\"margin:24px 0;display:flex;gap:12px;flex-wrap:wrap;\">\n       <a href=\"https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-dunning?mode=homeowner_choice&failure_id=fail-123&choice=proceed\"\n          style=\"display:inline-block;background:#14B8A6;color:#ffffff;padding:14px 28px;\n                 border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;\">\n         Move Forward with Acme Roofing & Sons\n       </a>\n       &nbsp;&nbsp;\n       <a href=\"https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-dunning?mode=homeowner_choice&failure_id=fail-123&choice=different\"\n          style=\"display:inline-block;background:#6B7280;color:#ffffff;padding:14px 28px;\n                 border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;\">\n         Choose a Different Contractor\n       </a>\n     </div>\n    <p style=\"color:#6B7280;font-size:13px;margin-top:20px;\">Questions? Contact us at support@otterquote.com</p>\n  </div>\n</div><div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>");
});

Deno.test("gh-1824 process-dunning: homeowner choice email TEXT as sent matches the pinned golden", () => {
  assertEquals(sentText(HOMEOWNER()), "Important Update on Your Project\n\nHi Pat Homeowner,\n\nThe payment method your contractor has on file with us has been declined.\nContractors typically charge thousands of dollars to their credit cards for materials\nevery day. So this is probably just an oversight on their part. But there is a small\nchance that this could be a sign of financial concerns. We have not sent your contact\ninformation to this contractor.\n\nAt this time, you have the option to move forward with the contractor you have\nselected or select another contractor for your project.\n\nMove Forward with Acme Roofing & Sons: https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-dunning?mode=homeowner_choice&failure_id=fail-123&choice=proceed\n\nChoose a Different Contractor: https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-dunning?mode=homeowner_choice&failure_id=fail-123&choice=different\n\nQuestions? Contact us at support@otterquote.com\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 process-dunning: contractor lost-project email HTML as sent matches the pinned golden", () => {
  assertEquals(sentHtml(contractorLostProjectEmail(CO)), "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;\">\n  <div style=\"background:#0B1929;padding:20px;border-radius:8px 8px 0 0;text-align:center;\">\n    <img src=\"https://otterquote.com/img/otter-logo.svg\" alt=\"Otter Quotes\" style=\"width:40px;height:40px;\">\n    <h1 style=\"color:#EF4444;font-size:18px;margin:10px 0 0;\">Project Update</h1>\n  </div>\n  <div style=\"background:#ffffff;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px;\">\n    <p>Hi Acme Roofing & Sons,</p>\n     <p>The homeowner on your pending project has chosen to select a different contractor\n     due to the unresolved payment issue on their file.</p>\n     <p>Please update your payment method at <a href=\"https://otterquote.com/contractor-settings.html\">https://otterquote.com/contractor-settings.html</a>\n     to ensure this doesn't happen on future projects.</p>\n    <p style=\"color:#6B7280;font-size:13px;margin-top:20px;\">Questions? Contact us at support@otterquote.com</p>\n  </div>\n</div><div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>");
});

Deno.test("gh-1824 process-dunning: contractor lost-project email TEXT as sent matches the pinned golden", () => {
  assertEquals(sentText(contractorLostProjectEmail(CO)), "Project Update\n\nHi Acme Roofing & Sons,\n\nThe homeowner on your pending project has chosen to select a different contractor\ndue to the unresolved payment issue on their file.\n\nPlease update your payment method at https://otterquote.com/contractor-settings.html: https://otterquote.com/contractor-settings.html\nto ensure this doesn't happen on future projects.\n\nQuestions? Contact us at support@otterquote.com\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 process-dunning: contractor proceed email HTML as sent matches the pinned golden", () => {
  assertEquals(sentHtml(contractorProceedEmail(CO)), "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;\">\n  <div style=\"background:#0B1929;padding:20px;border-radius:8px 8px 0 0;text-align:center;\">\n    <img src=\"https://otterquote.com/img/otter-logo.svg\" alt=\"Otter Quotes\" style=\"width:40px;height:40px;\">\n    <h1 style=\"color:#14B8A6;font-size:18px;margin:10px 0 0;\">Homeowner Chose to Move Forward</h1>\n  </div>\n  <div style=\"background:#ffffff;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px;\">\n    <p>Hi Acme Roofing & Sons,</p>\n     <p>The homeowner has elected to move forward with you as their contractor.</p>\n     <p><strong>Important:</strong> By continuing, you are liable for all platform fees,\n     a $250 nonpayment fee, and any attorney's fees and costs associated with collecting\n     this amount from you, in addition to the original platform fee.</p>\n     <p>Please update your payment method immediately at <a href=\"https://otterquote.com/contractor-settings.html\">https://otterquote.com/contractor-settings.html</a>.\n     The homeowner's contact information will be released to you shortly.</p>\n    <p style=\"color:#6B7280;font-size:13px;margin-top:20px;\">Questions? Contact us at support@otterquote.com</p>\n  </div>\n</div><div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>");
});

Deno.test("gh-1824 process-dunning: contractor proceed email TEXT as sent matches the pinned golden", () => {
  assertEquals(sentText(contractorProceedEmail(CO)), "Homeowner Chose to Move Forward\n\nHi Acme Roofing & Sons,\n\nThe homeowner has elected to move forward with you as their contractor.\n\nImportant: By continuing, you are liable for all platform fees,\na $250 nonpayment fee, and any attorney's fees and costs associated with collecting\nthis amount from you, in addition to the original platform fee.\n\nPlease update your payment method immediately at https://otterquote.com/contractor-settings.html: https://otterquote.com/contractor-settings.html.\nThe homeowner's contact information will be released to you shortly.\n\nQuestions? Contact us at support@otterquote.com\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 process-dunning: admin alert shell (adminAlertEmail) HTML as sent matches the pinned golden", () => {
  assertEquals(sentHtml(adminAlertEmail("Subject <X>", "<p>body</p>")), "<div style=\"font-family:monospace;padding:20px;\"><h2>Subject <X></h2><p>body</p></div><div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>");
});

Deno.test("gh-1824 process-dunning: admin alert shell (adminAlertEmail) TEXT as sent matches the pinned golden", () => {
  assertEquals(sentText(adminAlertEmail("Subject <X>", "<p>body</p>")), "Subject\n\nbody\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 process-dunning: admin alert: homeowner proceeded HTML as sent matches the pinned golden", () => {
  assertEquals(sentHtml(proceededAdminAlertEmail("fail-123", CO, "ctr-456", "456 Oak Ave, Carmel, IN 46032", 12345)), "<div style=\"font-family:monospace;padding:20px;\"><h2>Homeowner Chose to Proceed</h2>\n            <p><strong>Failure ID:</strong> fail-123</p>\n            <p><strong>Contractor:</strong> Acme Roofing & Sons (ctr-456)</p>\n            <p><strong>Claim:</strong> 456 Oak Ave, Carmel, IN 46032</p>\n            <p><strong>Amount owed:</strong> $123.45 platform fee + $250 nonpayment fee + attorney's fees</p>\n            <p><strong>Action needed:</strong> Manually collect fees and release homeowner contact info.</p>\n          </div><div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>");
});

Deno.test("gh-1824 process-dunning: admin alert: homeowner proceeded TEXT as sent matches the pinned golden", () => {
  assertEquals(sentText(proceededAdminAlertEmail("fail-123", CO, "ctr-456", "456 Oak Ave, Carmel, IN 46032", 12345)), "Homeowner Chose to Proceed\n\nFailure ID: fail-123\n\nContractor: Acme Roofing & Sons (ctr-456)\n\nClaim: 456 Oak Ave, Carmel, IN 46032\n\nAmount owed: $123.45 platform fee + $250 nonpayment fee + attorney's fees\n\nAction needed: Manually collect fees and release homeowner contact info.\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 process-dunning: admin alert: homeowner proceeded (claim address missing, falls back to claim_id) HTML as sent matches the pinned golden", () => {
  assertEquals(sentHtml(proceededAdminAlertEmail("fail-123", CO, "ctr-456", "clm-789", 12345)), "<div style=\"font-family:monospace;padding:20px;\"><h2>Homeowner Chose to Proceed</h2>\n            <p><strong>Failure ID:</strong> fail-123</p>\n            <p><strong>Contractor:</strong> Acme Roofing & Sons (ctr-456)</p>\n            <p><strong>Claim:</strong> clm-789</p>\n            <p><strong>Amount owed:</strong> $123.45 platform fee + $250 nonpayment fee + attorney's fees</p>\n            <p><strong>Action needed:</strong> Manually collect fees and release homeowner contact info.</p>\n          </div><div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>");
});

Deno.test("gh-1824 process-dunning: admin alert: homeowner proceeded (claim address missing, falls back to claim_id) TEXT as sent matches the pinned golden", () => {
  assertEquals(sentText(proceededAdminAlertEmail("fail-123", CO, "ctr-456", "clm-789", 12345)), "Homeowner Chose to Proceed\n\nFailure ID: fail-123\n\nContractor: Acme Roofing & Sons (ctr-456)\n\nClaim: clm-789\n\nAmount owed: $123.45 platform fee + $250 nonpayment fee + attorney's fees\n\nAction needed: Manually collect fees and release homeowner contact info.\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 process-dunning: admin alert: homeowner chose a different contractor HTML as sent matches the pinned golden", () => {
  assertEquals(sentHtml(differentContractorAdminAlertEmail("fail-123", CO, "ctr-456", "456 Oak Ave, Carmel, IN 46032")), "<div style=\"font-family:monospace;padding:20px;\"><h2>Homeowner Chose Different Contractor</h2>\n            <p><strong>Failure ID:</strong> fail-123</p>\n            <p><strong>Contractor:</strong> Acme Roofing & Sons (ctr-456)</p>\n            <p><strong>Claim:</strong> 456 Oak Ave, Carmel, IN 46032</p>\n            <p><strong>Result:</strong> Claim reset to bidding. Contractor notified.</p>\n          </div><div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>");
});

Deno.test("gh-1824 process-dunning: admin alert: homeowner chose a different contractor TEXT as sent matches the pinned golden", () => {
  assertEquals(sentText(differentContractorAdminAlertEmail("fail-123", CO, "ctr-456", "456 Oak Ave, Carmel, IN 46032")), "Homeowner Chose Different Contractor\n\nFailure ID: fail-123\n\nContractor: Acme Roofing & Sons (ctr-456)\n\nClaim: 456 Oak Ave, Carmel, IN 46032\n\nResult: Claim reset to bidding. Contractor notified.\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 process-dunning: admin alert: homeowner notified (10 AM) HTML as sent matches the pinned golden", () => {
  assertEquals(sentHtml(homeownerNotifiedAdminAlertEmail("fail-123", CO, "ctr-456", "456 Oak Ave, Carmel, IN 46032", 12345, 4)), "<div style=\"font-family:monospace;padding:20px;\"><h2>Homeowner Notified (10 AM)</h2>\n          <p><strong>Failure ID:</strong> fail-123</p>\n          <p><strong>Contractor:</strong> Acme Roofing & Sons (ctr-456)</p>\n          <p><strong>Claim:</strong> 456 Oak Ave, Carmel, IN 46032</p>\n          <p><strong>Amount:</strong> $123.45</p>\n          <p><strong>Reminders sent:</strong> 4</p>\n          <p>Homeowner has been emailed with two CTAs. Waiting for their choice.</p>\n        </div><div style=\"margin-top:6px;\">Stellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224</div>");
});

Deno.test("gh-1824 process-dunning: admin alert: homeowner notified (10 AM) TEXT as sent matches the pinned golden", () => {
  assertEquals(sentText(homeownerNotifiedAdminAlertEmail("fail-123", CO, "ctr-456", "456 Oak Ave, Carmel, IN 46032", 12345, 4)), "Homeowner Notified (10 AM)\n\nFailure ID: fail-123\n\nContractor: Acme Roofing & Sons (ctr-456)\n\nClaim: 456 Oak Ave, Carmel, IN 46032\n\nAmount: $123.45\n\nReminders sent: 4\n\nHomeowner has been emailed with two CTAs. Waiting for their choice.\n\nStellar Edge Services, LLC d/b/a Otter Quotes · 3410 N High School Rd, Ste G #102, Indianapolis, IN 46224");
});

Deno.test("gh-1824 process-dunning: goldens still contain the D-237 postal address (sanity check on the goldens themselves)", () => {
  assertEquals(sentHtml(warningEmail(CO)).includes(POSTAL_ADDRESS), true);
  assertEquals(sentText(warningEmail(CO)).includes(POSTAL_ADDRESS), true);
});
