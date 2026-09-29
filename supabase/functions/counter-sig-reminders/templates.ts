// templates.ts (gh-1824 footer batch 3)
//
// Email HTML/text builders for counter-sig-reminders, split out of
// index.ts so they can be unit-tested without importing index.ts (which
// calls `serve()` at module load time and would start listening for
// requests). Same convention as send-message-notification/templates.ts
// (gh-1824 footer batch 2).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export const CONTRACTOR_DASHBOARD_URL =
  "https://otterquote.com/contractor-dashboard.html";

/**
 * Shared branded HTML wrapper. Navy (#0D1B2E) header, amber (#E07B00) accent.
 */
export function wrapEmail(params: {
  heading: string;
  bodyHtml: string;
  ctaText: string;
  ctaUrl: string;
}): string {
  const { heading, bodyHtml, ctaText, ctaUrl } = params;

  const ctaBlock = `<p style="text-align:center;margin:28px 0 0;">
         <a href="${ctaUrl}"
            style="display:inline-block;background:#E07B00;color:#fff;padding:13px 28px;
                   border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;
                   letter-spacing:0.01em;">
           ${ctaText}
         </a>
       </p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:#F8F9FC;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8F9FC;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:10px;overflow:hidden;
                      box-shadow:0 2px 8px rgba(0,0,0,0.07);">
          <!-- Header bar -->
          <tr>
            <td style="background:#0D1B2E;padding:20px 32px;">
              <span style="color:#E07B00;font-size:20px;font-weight:700;
                           letter-spacing:0.03em;">Otter Quotes</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px 32px 24px;">
              <h2 style="margin:0 0 18px;color:#0D1B2E;font-size:20px;
                          font-weight:700;line-height:1.3;">${heading}</h2>
              ${bodyHtml}
              ${ctaBlock}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#F8F9FC;padding:16px 32px;
                       border-top:1px solid #E2E8F0;">
              <p style="margin:0;color:#94A3B8;font-size:11px;line-height:1.5;">
                Otter Quotes &nbsp;&bull;&nbsp; Powered by Stellar Edge Services LLC
                &nbsp;&bull;&nbsp;
                <a href="https://otterquote.com" style="color:#94A3B8;">otterquote.com</a>
                <br />
                You received this email because you have an active contractor account.
                Questions? Reply to this email or call (844) 875-3412.
                ${footerPostalAddressHtml()}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildReminderEmail(params: {
  contractorName: string;
  propertyAddress: string;
  jobNumber: string;
  hoursSinceSigned: number;
}): { subject: string; text: string; html: string } {
  const { contractorName, propertyAddress, jobNumber, hoursSinceSigned } = params;

  const subject = "Reminder: contract awaiting your counter-signature";

  const text = `Hi ${contractorName},

The homeowner signed the contract for ${propertyAddress} (${jobNumber}) about ${hoursSinceSigned} hours ago, and it is still awaiting your counter-signature.

Once you sign, the agreement is fully executed and the project can move forward.

Counter-sign from your dashboard:
${CONTRACTOR_DASHBOARD_URL}

You will continue to receive these reminders every 2 hours during business hours until the contract is fully executed.

Questions? Reply to this email or call (844) 875-3412.

— The Otter Quotes Team

${footerPostalAddressText()}`;

  const bodyHtml = `
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Hi ${contractorName},
    </p>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      The homeowner signed the contract for <strong>${propertyAddress}</strong>
      (${jobNumber}) about <strong>${hoursSinceSigned} hours ago</strong>, and it is
      still awaiting your counter-signature.
    </p>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Once you sign, the agreement is fully executed and the project can move forward.
    </p>
    <p style="margin:0;color:#3D4F60;font-size:13px;line-height:1.6;">
      You will continue to receive these reminders every 2 hours during business
      hours until the contract is fully executed.
    </p>`;

  const html = wrapEmail({
    heading: "Contract awaiting your counter-signature",
    bodyHtml,
    ctaText: "Counter-Sign Now",
    ctaUrl: CONTRACTOR_DASHBOARD_URL,
  });

  return { subject, text, html };
}
