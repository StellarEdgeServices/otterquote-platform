// templates.ts (gh-1824 footer batch 2)
//
// Email HTML/text builders for send-message-notification, split out of
// index.ts so they can be unit-tested without importing index.ts (which
// calls `serve()` at module load time and would start listening for
// requests). Same convention as send-homeowner-next-steps/email-content.ts.

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export function buildEmail(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #333; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; }
    .header { background: #001D3D; color: #fff; padding: 24px 32px; }
    .content { padding: 32px; }
    .footer { background: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 20px 32px; text-align: center; font-size: 13px; color: #64748B; }
    a { color: #0EA5E9; text-decoration: none; }
    .button { display: inline-block; background: #14B8A6; color: #fff; padding: 12px 24px; border-radius: 8px; font-weight: 600; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin: 0;">Otter Quotes</h2>
    </div>
    <div class="content">
      ${bodyHtml}
    </div>
    <div class="footer">
      <p style="margin: 0 0 12px 0;">Need help? Contact <a href="mailto:support@otterquote.com">support@otterquote.com</a> or call (844) 875-3412</p>
      ${footerPostalAddressHtml()}
    </div>
  </div>
</body>
</html>`;
}

/**
 * Plain-text fallback for the new-message notification email (gh-1013).
 * Per #869 AC 2, this deliberately keeps the bare URL — text/plain clients
 * cannot render a styled link, and this is the accessibility + HTML-blocked
 * fallback. Never strip the URL here.
 */
export function messageNotificationText(
  recipientName: string,
  senderName: string,
  messagePreview: string,
  truncated: boolean,
  dashboardUrl: string
): string {
  return `Hi ${recipientName},

You have a new message from ${senderName} regarding your project.

Message preview:
"${messagePreview}${truncated ? "..." : ""}"

View message: ${dashboardUrl}

Log in to Otter Quotes to read and reply to the full message.

---
Need help? Contact support@otterquote.com or call (844) 875-3412

${footerPostalAddressText()}`;
}
