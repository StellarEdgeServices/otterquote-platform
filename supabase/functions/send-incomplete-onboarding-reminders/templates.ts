// templates.ts (gh-1824 footer batch 2)
//
// Email HTML/text builders for send-incomplete-onboarding-reminders, split
// out of index.ts so they can be unit-tested without importing index.ts
// (which calls `serve()` at module load time and would start listening for
// requests). Same convention as send-homeowner-next-steps/email-content.ts.

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export function buildReminderEmail(contactName: string): string {
  const previewName = contactName ? `Hi ${contactName.split(' ')[0]},` : 'Hi there,';
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
            <p style="margin:0 0 16px;font-size:16px;color:#1E293B;">${previewName}</p>
            <p style="margin:0 0 16px;font-size:16px;color:#1E293B;line-height:1.6;">
              You started your application to join the Otter Quotes contractor network but haven't finished yet.
            </p>
            <p style="margin:0 0 24px;font-size:16px;color:#1E293B;line-height:1.6;">
              It only takes a few more minutes to complete. Pick up right where you left off — your progress has been saved.
            </p>
            <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
              <tr>
                <td style="background:#E07B00;border-radius:8px;padding:14px 28px;">
                  <a href="https://otterquote.com/contractor-pre-approval.html"
                     style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">
                    Complete Your Application →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px;font-size:14px;color:#64748B;line-height:1.6;">
              Once approved, you'll receive signed contracts directly — no cold calls, no chasing prospects.
            </p>
            <p style="margin:0;font-size:14px;color:#64748B;">
              Questions? Reply to this email or contact
              <a href="mailto:support@otterquote.com" style="color:#E07B00;">support@otterquote.com</a>.
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
            <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <a href="tel:+18448753412" style="color:#0EA5E9;text-decoration:none;">(844) 875-3412</a>
            ${footerPostalAddressHtml()}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export function buildReminderText(contactName: string): string {
  return `Hi ${contactName || 'there'},\n\nYou started your application to join the Otter Quotes contractor network but haven't finished yet.\n\nPick up where you left off: https://otterquote.com/contractor-pre-approval.html\n\nQuestions? Contact support@otterquote.com\n\n${footerPostalAddressText()}`;
}
