// templates.ts (gh-1824 footer batch 5)
//
// Email HTML/text builders for process-payout-reminders' Day-2 commission
// digest to Dustin, split out of index.ts so they can be unit-tested without
// importing index.ts (which calls `serve()` at module load time and would
// start listening for requests). Same convention as
// send-message-notification/templates.ts (gh-1824 footer batch 2).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export interface PendingReminderRow {
  partner_name: string | null;
  amount: number;
  payout_type: string;
  created_at: string | null;
}

export function formatCurrency(amount: number): string {
  return `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPayoutType(type: string): string {
  return type === "commission_referral" ? "Referral" : "Recruit Bonus";
}

// ── Inlined from _shared/email.ts (#869) — see that file's header comment ──
// for why this is duplicated rather than imported (the EF body-deploy path
// does not resolve `_shared/` imports). Table-based CTA + MSO VML conditional
// so Outlook renders a real filled rectangle, not a bare link. Brand amber
// #E07B00 (this function already defaulted to it — now canonical + Outlook-safe).
export function emailButton({ href, label }: { href: string; label: string }): string {
  const BRAND_AMBER = "#E07B00";
  const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
  return `
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="15%" strokecolor="${BRAND_AMBER}" fillcolor="${BRAND_AMBER}">
  <w:anchorlock/>
  <center style="color:#ffffff;font-family:${FONT_STACK};font-size:16px;font-weight:700;">${label}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="${BRAND_AMBER}" style="border-radius:8px;">
      <a href="${href}" style="display:inline-block;font-family:${FONT_STACK};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">${label}</a>
    </td>
  </tr>
</table>
<!--<![endif]-->`.trim();
}

// gh-1824: the D-237 postal address is appended below the existing
// support-email link, not in place of it.
function emailFooter(): string {
  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
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
      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                         font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">
              Otter Quotes
            </span>
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

export function reminderDigestBodyHtml(pendingReminder: PendingReminderRow[], totalAmount: number, adminPayoutsUrl: string): string {
  const rowsHtml = pendingReminder.map(p => {
    const pendingSince = p.created_at
      ? new Date(p.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : "—";
    return `
<tr>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#0B1929;">${p.partner_name || "Unknown"}</td>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#64748B;">${formatPayoutType(p.payout_type)}</td>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;font-weight:600;color:#0B1929;">${formatCurrency(Number(p.amount))}</td>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#EF4444;">${pendingSince}</td>
</tr>`;
  }).join("");

  return `
<h2 style="font-size:1.5rem;font-weight:700;color:#0B1929;margin:0 0 8px;">
  ⏰ Reminder: ${pendingReminder.length} Commission${pendingReminder.length === 1 ? "" : "s"} Awaiting Approval
</h2>
<p style="color:#374151;font-size:0.95rem;margin:0 0 24px;">
  The following commissions have been pending for more than 2 days and require your review.
  Total pending: <strong>${formatCurrency(totalAmount)}</strong>
</p>

<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="border-radius:8px;border:1px solid #E2E8F0;overflow:hidden;margin-bottom:24px;">
  <thead>
    <tr style="background:#F8FAFC;">
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Partner</th>
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Type</th>
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Amount</th>
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Pending Since</th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
</table>

${emailButton({ href: adminPayoutsUrl, label: "Review All Pending Approvals →" })}
`;
}

export function reminderDigestBodyText(pendingReminder: PendingReminderRow[], totalAmount: number, adminPayoutsUrl: string): string {
  return [
    `Reminder: ${pendingReminder.length} commission(s) awaiting approval (>2 days pending)`,
    `Total: ${formatCurrency(totalAmount)}`,
    ``,
    ...pendingReminder.map(p =>
      `- ${p.partner_name || "Unknown"}: ${formatCurrency(Number(p.amount))} (${formatPayoutType(p.payout_type)})`
    ),
    ``,
    `Review here: ${adminPayoutsUrl}`,
    ``,
    footerPostalAddressText(),
  ].join("\n");
}
