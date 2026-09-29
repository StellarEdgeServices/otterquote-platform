// templates.ts (gh-1824 footer batch 3)
//
// Email HTML/text builders for mark-job-complete's D-228 homeowner
// notification, split out of index.ts so they can be unit-tested without
// importing index.ts (which calls `serve()` at module load time and would
// start listening for requests). Same convention as
// send-message-notification/templates.ts (gh-1824 footer batch 2).
//
// The previous footer here carried an ad-hoc, non-canonical partial address
// ("Otter Quotes · Indianapolis, IN ·") -- replaced with the full D-237
// canonical address (see email-footer.ts).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export function jobCompleteEmailText(
  homeownerName: string,
  contractorName: string,
  address: string,
  formattedDate: string,
): string {
  return [
    `Hi ${homeownerName},`,
    "",
    `${contractorName} has marked the job at ${address} as complete as of ${formattedDate}.`,
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
}

export function jobCompleteEmailHtml(
  homeownerName: string,
  contractorName: string,
  address: string,
  formattedDate: string,
): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1F2937;">
  <div style="text-align:center;margin-bottom:2rem;">
    <img src="https://otterquote.com/images/otter-logo.png" alt="Otter Quotes" style="height:48px;" onerror="this.style.display='none'">
  </div>
  <h2 style="color:#0D1B2E;margin-bottom:1rem;">Job Marked Complete</h2>
  <p>Hi ${homeownerName},</p>
  <p><strong>${contractorName}</strong> has marked the job at <strong>${address}</strong> as complete as of <strong>${formattedDate}</strong>.</p>
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
}
