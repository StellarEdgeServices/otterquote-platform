// templates.ts (gh-1824 footer batch 4)
//
// Email HTML/text builders for notify-feature-request, split out of index.ts
// so they can be unit-tested without importing index.ts (which calls
// `serve()` at module load time and would start listening for requests).
// Same convention as send-homeowner-next-steps/email-content.ts and
// admin-contractor-action/templates.ts (batch 3).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

/** Escape a string for safe HTML interpolation. */
export function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain-text body for the internal feature-request alert. */
export function featureRequestEmailText(
  contractorName: string,
  contractorEmail: string,
  requestText: string,
  createdAt: string
): string {
  return [
    "New feature request submitted on OtterQuote.",
    "",
    `Contractor : ${contractorName}`,
    `Email      : ${contractorEmail}`,
    `Submitted  : ${createdAt} (CT)`,
    "",
    "─".repeat(33),
    requestText,
    "─".repeat(33),
    "",
    "View all requests in your Supabase dashboard:",
    "https://app.supabase.com → Table Editor → feature_requests",
    "",
    footerPostalAddressText(),
  ].join("\n");
}

/** HTML body for the internal feature-request alert. */
export function featureRequestEmailHtml(
  contractorName: string,
  contractorEmail: string,
  requestText: string,
  createdAt: string
): string {
  return `
      <div style="font-family:sans-serif; max-width:600px; margin:0 auto; color:#0B1929;">
        <div style="background:#0B1929; padding:20px 24px; border-radius:8px 8px 0 0;">
          <h2 style="color:#F59E0B; margin:0; font-size:1.1rem;">🦦 New OtterQuote Feature Request</h2>
        </div>
        <div style="background:#F8FAFC; padding:24px; border:1px solid #E2E8F0; border-top:none; border-radius:0 0 8px 8px;">
          <table style="width:100%; border-collapse:collapse; font-size:0.9rem; margin-bottom:20px;">
            <tr>
              <td style="padding:6px 0; color:#64748B; width:110px;">Contractor</td>
              <td style="padding:6px 0; font-weight:600;">${escapeHtml(contractorName)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0; color:#64748B;">Email</td>
              <td style="padding:6px 0;"><a href="mailto:${escapeHtml(contractorEmail)}" style="color:#0369A1;">${escapeHtml(contractorEmail)}</a></td>
            </tr>
            <tr>
              <td style="padding:6px 0; color:#64748B;">Submitted</td>
              <td style="padding:6px 0;">${escapeHtml(createdAt)} CT</td>
            </tr>
          </table>
          <div style="background:white; border:1px solid #CBD5E1; border-radius:6px; padding:16px; font-size:0.95rem; line-height:1.6; white-space:pre-wrap;">${escapeHtml(requestText)}</div>
          <p style="margin-top:20px; font-size:0.8rem; color:#94A3B8;">
            View all requests in your
            <a href="https://app.supabase.com" style="color:#0369A1;">Supabase dashboard</a>
            → Table Editor → feature_requests
          </p>
          ${footerPostalAddressHtml()}
        </div>
      </div>
    `;
}
