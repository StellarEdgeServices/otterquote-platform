// templates.ts (gh-1824 footer batch 5)
//
// Email text builder for send-support-email's forward-to-admin-inbox message,
// split out of index.ts so it can be unit-tested without importing index.ts
// (which calls `serve()` at module load time and would start listening for
// requests). Same convention as send-message-notification/templates.ts
// (gh-1824 footer batch 2).

import { footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export function supportEmailBody(
  fromName: string,
  fromEmail: string,
  subject: string | undefined,
  message: string,
): string {
  return `Otter Quotes Support Request
===========================
From:    ${fromName}
Email:   ${fromEmail}
Subject: ${subject || "(none)"}

Message:
${message}

---
Sent via Otter Quotes support form.
Reply directly to this email to respond.

${footerPostalAddressText()}`;
}
