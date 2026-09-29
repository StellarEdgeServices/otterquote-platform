// templates.ts (gh-1824 footer batch 3)
//
// Email HTML/text builders for admin-contractor-action, split out of
// index.ts so they can be unit-tested without importing index.ts (which
// calls `serve()` at module load time and would start listening for
// requests). Same convention as send-homeowner-next-steps/email-content.ts
// and send-message-notification/templates.ts (gh-1824 footer batch 2).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export const DASHBOARD_URL = "https://otterquote.com/contractor-dashboard.html";
export const SETTINGS_URL = "https://otterquote.com/contractor-settings.html";

function emailFooter(): string {
  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
      &nbsp;&nbsp;|&nbsp;&nbsp;
      <a href="tel:+18448753412" style="color:#0EA5E9;text-decoration:none;">(844) 875-3412</a>
      ${footerPostalAddressHtml()}
    </td>
  </tr>
</table>`.trim();
}

export function buildEmail(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Otter Quotes</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            ${bodyHtml}
          </td>
        </tr>
        <tr><td>${emailFooter()}</td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

export function approvalEmailText(greeting: string): string {
  return `Hi ${greeting},

Great news — your Otter Quotes contractor account has been approved. You can now browse available opportunities and submit bids.

Log in to get started: ${DASHBOARD_URL}

Before submitting your first bid, complete these steps in your Getting Started checklist:
- Add a payment method (required to receive projects)
- Upload your contract template
- Select your preferred shingle brand

Tip: Enable Auto-Bid in Settings to automatically compete for every matching opportunity — no action needed between jobs.

Questions? support@otterquote.com | (844) 875-3412

The Otter Quotes Team

${footerPostalAddressText()}`;
}

export function approvalEmailHtml(greeting: string): string {
  return buildEmail(`
          <p style="margin:0 0 6px;color:#14B8A6;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">You're Approved</p>
          <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Welcome to Otter Quotes, ${greeting}!</h2>

          <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">Your account is active. You can now browse available opportunities and submit bids.</p>

          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;margin-bottom:24px;">
            <tr><td style="padding:16px 20px;">
              <p style="margin:0 0 10px;color:#166534;font-size:14px;font-weight:700;">Complete these steps before your first bid:</p>
              <table cellpadding="0" cellspacing="0" border="0">
                <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">1.&nbsp; Add a payment method (required to receive projects)</td></tr>
                <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">2.&nbsp; Upload your contract template</td></tr>
                <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">3.&nbsp; Select your preferred shingle brand</td></tr>
              </table>
            </td></tr>
          </table>

          <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
            <tr>
              <td align="center" bgcolor="#14B8A6" style="border-radius:8px;">
                <a href="${DASHBOARD_URL}" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">Go to My Dashboard &rarr;</a>
              </td>
            </tr>
          </table>

          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;">
            <tr>
              <td style="padding:14px 16px;">
                <p style="margin:0 0 4px;color:#92400E;font-size:14px;font-weight:600;">&#9889; Enable Auto-Bid</p>
                <p style="margin:0;color:#78350F;font-size:13px;line-height:1.5;">Auto-Bid places you in the running for every matching opportunity automatically &mdash; no action needed between jobs. Set it up in <a href="${SETTINGS_URL}" style="color:#92400E;">Settings</a>.</p>
              </td>
            </tr>
          </table>
        `);
}

export function rejectionEmailText(greeting: string, reason: string): string {
  return `Hi ${greeting},

Thank you for applying to join the Otter Quotes contractor network. After reviewing your application, we weren't able to approve your account at this time.

Reason: ${reason}

If you'd like to address this and reapply, please contact us at support@otterquote.com or call (844) 875-3412. We're happy to work with you to get things squared away.

The Otter Quotes Team

${footerPostalAddressText()}`;
}

export function rejectionEmailHtml(greeting: string, reason: string): string {
  return buildEmail(`
          <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Update on Your Otter Quotes Application</h2>

          <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Hi ${greeting},</p>
          <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Thank you for applying to join the Otter Quotes contractor network. After reviewing your application, we weren't able to approve your account at this time.</p>

          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;margin-bottom:20px;">
            <tr><td style="padding:14px 16px;">
              <p style="margin:0;color:#991B1B;font-size:14px;"><strong>Reason:</strong> ${reason}</p>
            </td></tr>
          </table>

          <p style="margin:0;color:#374151;font-size:15px;line-height:1.6;">If you'd like to address this and reapply, please contact us at <a href="mailto:support@otterquote.com" style="color:#E07B00;">support@otterquote.com</a> or call (844) 875-3412. We're happy to work with you to get things squared away.</p>
        `);
}

export function coiEmailText(contractorCompanyName: string): string {
  return `Dear Insurance Representative,

We are writing to verify the Certificate of Insurance on file for ${contractorCompanyName}, who has applied to join the Otter Quotes contractor network.

We are requesting confirmation that the following policies are currently active and in good standing for this insured:
- Commercial General Liability Insurance
- Workers' Compensation Insurance

Please reply to this email confirming policy status, or contact us at info@otterquote.com or (844) 875-3412 with any questions.

Thank you for your time.

Otter Quotes
info@otterquote.com
(844) 875-3412
https://otterquote.com

${footerPostalAddressText()}`;
}

export function coiEmailHtml(contractorCompanyName: string): string {
  return buildEmail(`
          <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Certificate of Insurance Verification Request</h2>

          <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Dear Insurance Representative,</p>
          <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">We are writing to verify the Certificate of Insurance on file for <strong>${contractorCompanyName}</strong>, who has applied to join the Otter Quotes contractor network.</p>
          <p style="margin:0 0 8px;color:#374151;font-size:15px;line-height:1.6;">We are requesting confirmation that the following policies are currently active and in good standing for this insured:</p>
          <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
            <tr><td style="padding:2px 0;color:#374151;font-size:15px;">&bull;&nbsp; Commercial General Liability Insurance</td></tr>
            <tr><td style="padding:2px 0;color:#374151;font-size:15px;">&bull;&nbsp; Workers' Compensation Insurance</td></tr>
          </table>
          <p style="margin:0;color:#374151;font-size:15px;line-height:1.6;">Please reply to this email confirming policy status, or contact us at <a href="mailto:info@otterquote.com" style="color:#E07B00;">info@otterquote.com</a> or (844) 875-3412 with any questions.</p>
      `);
}
