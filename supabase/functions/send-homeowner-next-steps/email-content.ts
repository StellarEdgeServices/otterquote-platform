// gh-1786 / D-320 — the nudge email's copy, MOVED VERBATIM out of index.ts so
// the D-320 "stop these updates" footer can be tested without importing
// index.ts (importing it would call serve() and bind a port).
//
// Nothing in the pre-existing copy is changed. What is added, and only this:
//   * an `optOutUrl` parameter, now REQUIRED — the type makes it impossible to
//     build one of these messages without an opt-out link, which is the whole
//     point of #1786;
//   * one plain-text line and one plain HTML link in the footer, wording taken
//     from D-320 point 4 ("a plain 'stop these updates' footer link on both
//     emails"). Both stages ('2h' and '48h') render from this one function, so
//     one footer covers both emails.
//
// R-120: the two added customer-facing strings are the human-read content on
// this PR. They carry no price, no contractor name and no third-party vendor
// name (D-312), and they promise only what the endpoint does.

// The homeowner-facing opt-out wording. D-320 point 4, verbatim phrase.
export const OPTOUT_LINK_TEXT = "Stop these updates";
export const OPTOUT_TEXT_LINE = "Don't want these emails? Stop these updates:";

// ─── Copy (locked — Tier B, gh-1580; footer added by gh-1786 / D-320) ─────

const NUDGE_TEXT =
  "You're one step from bids — order or upload your roof measurements, then pick your material.";

export function buildEmailContent(
  homeownerName: string,
  measurementsUrl: string,
  colorUrl: string,
  optOutUrl: string
): { subject: string; textBody: string; htmlBody: string } {
  if (!optOutUrl) {
    // Fail closed rather than emit a commercial email with no opt-out: #1786 is
    // open precisely because this function used to have no way to stop it.
    throw new Error("buildEmailContent: optOutUrl is required (gh-1786 / D-320)");
  }
  const firstName = (homeownerName || "there").split(" ")[0] || "there";
  const subject = "You're one step from bids";

  const textBody = [
    `Hi ${firstName},`,
    "",
    NUDGE_TEXT,
    "",
    `Order or upload measurements: ${measurementsUrl}`,
    `Pick your material: ${colorUrl}`,
    "",
    "— The Otter Quotes Team",
    "",
    `${OPTOUT_TEXT_LINE} ${optOutUrl}`,
  ].join("\n");

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:Arial,Helvetica,sans-serif;color:#1F2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F8FAFC;">
    <tr>
      <td align="center" style="padding:2rem 1rem;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0"
               style="max-width:600px;width:100%;background:#ffffff;border-radius:0.75rem;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#0D1B2E;padding:1.5rem 2rem;text-align:center;">
              <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Otter Quotes</span>
            </td>
          </tr>
          <tr>
            <td style="padding:2rem 2rem 1.5rem;">
              <p style="margin:0 0 1rem;line-height:1.6;">Hi ${firstName},</p>
              <p style="margin:0 0 1.5rem;line-height:1.6;">${NUDGE_TEXT}</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 1rem;">
                <tr>
                  <td style="background:#E07B00;border-radius:8px;padding:14px 28px;">
                    <a href="${measurementsUrl}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">Order or Upload Measurements &rarr;</a>
                  </td>
                </tr>
              </table>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 1rem;">
                <tr>
                  <td style="background:#0EA5E9;border-radius:8px;padding:14px 28px;">
                    <a href="${colorUrl}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">Pick Your Material &rarr;</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0;font-size:14px;color:#64748B;">
                Questions? Reply to this email or contact
                <a href="mailto:support@otterquote.com" style="color:#E07B00;">support@otterquote.com</a>.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
              &mdash; The Otter Quotes Team
              <br><br>
              <a href="${optOutUrl}" style="color:#64748B;text-decoration:underline;">${OPTOUT_LINK_TEXT}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, textBody, htmlBody };
}
