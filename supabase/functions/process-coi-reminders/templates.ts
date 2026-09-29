// templates.ts (gh-1824 footer batch 4)
//
// Email HTML/text builders for process-coi-reminders, split out of index.ts
// so they can be unit-tested without importing index.ts (which calls
// `serve()` at module load time and would start listening for requests).
// Same convention as send-homeowner-next-steps/email-content.ts and
// admin-contractor-action/templates.ts (batch 3).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

// Upload CTA destination for COI emails.
export const COI_UPLOAD_URL =
  "https://otterquote.com/contractor-settings.html?reason=coi_required#coiCard";

// Upload CTA destination for WC certificate emails.
export const WC_UPLOAD_URL =
  "https://otterquote.com/contractor-settings.html?reason=wc_required#wcCard";

// CGL requirement copy — used in every COI email.
const COI_REQUIREMENTS = `
  • $1,000,000 per occurrence / $2,000,000 aggregate (Commercial General Liability)
  • Products-Completed Operations and Contractual Liability coverage included
  • Stellar Edge Services LLC named as Additional Insured, primary and non-contributory
`.trim();

// WC certificate requirement copy.
const WC_REQUIREMENTS = `
  • Active, continuous Workers' Compensation coverage
  • Covers all employees performing roofing-related work
  • Stellar Edge Services LLC named as Certificate Holder
`.trim();

// =============================================================================
// EMAIL BUILDERS — SHARED WRAPPER
// =============================================================================

/**
 * Shared branded HTML wrapper. Navy (#0D1B2E) header, amber (#E07B00) accent.
 */
function wrapEmail(params: {
  heading: string;
  headingColor?: string;
  bodyHtml: string;
  ctaText?: string;
  ctaUrl?: string;
  ctaColor?: string;
  mailgunDomain: string;
}): string {
  const {
    heading,
    headingColor = "#0D1B2E",
    bodyHtml,
    ctaText,
    ctaUrl,
    ctaColor = "#E07B00",
    mailgunDomain,
  } = params;

  const ctaBlock = ctaText && ctaUrl
    ? `<p style="text-align:center;margin:28px 0 0;">
         <a href="${ctaUrl}"
            style="display:inline-block;background:${ctaColor};color:#fff;padding:13px 28px;
                   border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;
                   letter-spacing:0.01em;">
           ${ctaText}
         </a>
       </p>`
    : "";

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
              <h2 style="margin:0 0 18px;color:${headingColor};font-size:20px;
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
              </p>
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

// ── COI EMAIL BUILDERS ───────────────────────────────────────────────────────

export function build30DayEmail(params: {
  contractorName: string;
  expiryDateDisplay: string;
  mailgunDomain: string;
}): { subject: string; text: string; html: string } {
  const { contractorName, expiryDateDisplay, mailgunDomain } = params;

  const subject = "Your COI expires in 30 days — action needed";

  const text = `Hi ${contractorName},

This is a heads-up that your Certificate of Insurance (COI) on file with Otter Quotes expires on ${expiryDateDisplay} — 30 days from now.

To keep bidding on projects without interruption, please upload an updated COI before that date.

COI requirements:
${COI_REQUIREMENTS}

Upload your updated COI here:
${COI_UPLOAD_URL}

If you have questions, reply to this email or call (844) 875-3412.

— The Otter Quotes Team

${footerPostalAddressText()}`;

  const bodyHtml = `
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Hi ${contractorName},
    </p>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Your Certificate of Insurance (COI) on file with Otter Quotes expires on
      <strong>${expiryDateDisplay}</strong> — 30 days from now.
    </p>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      To keep bidding on projects without interruption, please upload an updated COI
      before that date.
    </p>
    <div style="background:#FFF7ED;border-left:4px solid #E07B00;padding:14px 18px;
                border-radius:0 6px 6px 0;margin:0 0 18px;">
      <p style="margin:0 0 8px;color:#0D1B2E;font-size:13px;font-weight:700;">
        COI Requirements
      </p>
      <p style="margin:0;color:#3D4F60;font-size:13px;line-height:1.7;">
        • $1,000,000 per occurrence / $2,000,000 aggregate (Commercial General Liability)<br />
        • Products-Completed Operations and Contractual Liability coverage included<br />
        • <strong>Stellar Edge Services LLC</strong> named as Additional Insured,
          primary and non-contributory
      </p>
    </div>`;

  const html = wrapEmail({
    heading: "Your COI expires in 30 days — action needed",
    bodyHtml,
    ctaText: "Upload Updated COI",
    ctaUrl: COI_UPLOAD_URL,
    mailgunDomain,
  });

  return { subject, text, html };
}

export function build14DayEmail(params: {
  contractorName: string;
  expiryDateDisplay: string;
  mailgunDomain: string;
}): { subject: string; text: string; html: string } {
  const { contractorName, expiryDateDisplay, mailgunDomain } = params;

  const subject = "14 days until your COI expires";

  const text = `Hi ${contractorName},

Your Certificate of Insurance (COI) expires on ${expiryDateDisplay} — just 14 days away.

Once your COI expires, your account will be suspended and you will not be able to submit bids until a current COI is on file.

COI requirements:
${COI_REQUIREMENTS}

Upload your updated COI here:
${COI_UPLOAD_URL}

— The Otter Quotes Team

${footerPostalAddressText()}`;

  const bodyHtml = `
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Hi ${contractorName},
    </p>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Your Certificate of Insurance (COI) expires on <strong>${expiryDateDisplay}</strong>
      — just <strong>14 days away</strong>.
    </p>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Once your COI expires, your account will be suspended and you will not be able
      to submit bids until a current COI is on file. Don't let an active bid window slip away.
    </p>
    <div style="background:#FFF7ED;border-left:4px solid #E07B00;padding:14px 18px;
                border-radius:0 6px 6px 0;margin:0 0 18px;">
      <p style="margin:0 0 8px;color:#0D1B2E;font-size:13px;font-weight:700;">
        COI Requirements
      </p>
      <p style="margin:0;color:#3D4F60;font-size:13px;line-height:1.7;">
        • $1,000,000 per occurrence / $2,000,000 aggregate (Commercial General Liability)<br />
        • Products-Completed Operations and Contractual Liability coverage included<br />
        • <strong>Stellar Edge Services LLC</strong> named as Additional Insured,
          primary and non-contributory
      </p>
    </div>`;

  const html = wrapEmail({
    heading: "14 days until your COI expires",
    headingColor: "#92400E",
    bodyHtml,
    ctaText: "Upload Updated COI",
    ctaUrl: COI_UPLOAD_URL,
    ctaColor: "#E07B00",
    mailgunDomain,
  });

  return { subject, text, html };
}

export function build7DayEmail(params: {
  contractorName: string;
  expiryDateDisplay: string;
  mailgunDomain: string;
}): { subject: string; text: string; html: string } {
  const { contractorName, expiryDateDisplay, mailgunDomain } = params;

  const subject = "Your COI expires in 7 days — urgent";

  const text = `Hi ${contractorName},

URGENT: Your Certificate of Insurance (COI) expires on ${expiryDateDisplay} — only 7 days away.

If your COI is not updated before then, your Otter Quotes account will be suspended. You will not be able to view or bid on projects until a valid COI is on file.

COI requirements:
${COI_REQUIREMENTS}

Upload now — it only takes a minute:
${COI_UPLOAD_URL}

If you need help, reply to this email or call (844) 875-3412.

— The Otter Quotes Team

${footerPostalAddressText()}`;

  const bodyHtml = `
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Hi ${contractorName},
    </p>
    <div style="background:#FEF2F2;border-left:4px solid #DC2626;padding:12px 16px;
                border-radius:0 6px 6px 0;margin:0 0 16px;">
      <p style="margin:0;color:#991B1B;font-size:14px;font-weight:700;">
        ⚠️ Urgent: Your COI expires in 7 days (${expiryDateDisplay})
      </p>
    </div>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      If your COI is not updated before then, your Otter Quotes account will be
      <strong>suspended</strong>. You will not be able to view or bid on projects
      until a valid COI is on file.
    </p>
    <div style="background:#FFF7ED;border-left:4px solid #E07B00;padding:14px 18px;
                border-radius:0 6px 6px 0;margin:0 0 18px;">
      <p style="margin:0 0 8px;color:#0D1B2E;font-size:13px;font-weight:700;">
        COI Requirements
      </p>
      <p style="margin:0;color:#3D4F60;font-size:13px;line-height:1.7;">
        • $1,000,000 per occurrence / $2,000,000 aggregate (Commercial General Liability)<br />
        • Products-Completed Operations and Contractual Liability coverage included<br />
        • <strong>Stellar Edge Services LLC</strong> named as Additional Insured,
          primary and non-contributory
      </p>
    </div>
    <p style="margin:0 0 0;color:#3D4F60;font-size:14px;">
      Upload now — it only takes a minute.
    </p>`;

  const html = wrapEmail({
    heading: "Your COI expires in 7 days — urgent",
    headingColor: "#DC2626",
    bodyHtml,
    ctaText: "Upload Updated COI Now",
    ctaUrl: COI_UPLOAD_URL,
    ctaColor: "#DC2626",
    mailgunDomain,
  });

  return { subject, text, html };
}

export function buildExpiredEmail(params: {
  contractorName: string;
  expiredDateDisplay: string;
  mailgunDomain: string;
}): { subject: string; text: string; html: string } {
  const { contractorName, expiredDateDisplay, mailgunDomain } = params;

  const subject = "Your COI has expired — bidding suspended";

  const text = `Hi ${contractorName},

Your Certificate of Insurance (COI) expired on ${expiredDateDisplay}. Your Otter Quotes account has been suspended. You will not be able to view open projects or submit bids until a current COI is on file.

To reinstate your account, upload an updated COI immediately:
${COI_UPLOAD_URL}

COI requirements:
${COI_REQUIREMENTS}

Once a valid COI is uploaded and verified, your account status will be restored and you can resume bidding.

Questions? Reply to this email or call (844) 875-3412.

— The Otter Quotes Team

${footerPostalAddressText()}`;

  const bodyHtml = `
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Hi ${contractorName},
    </p>
    <div style="background:#FEF2F2;border-left:4px solid #DC2626;padding:12px 16px;
                border-radius:0 6px 6px 0;margin:0 0 16px;">
      <p style="margin:0;color:#991B1B;font-size:14px;font-weight:700;">
        Your COI expired on ${expiredDateDisplay}. Your account has been suspended.
      </p>
    </div>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      You will not be able to view open projects or submit bids until a current
      Certificate of Insurance is on file with Otter Quotes.
    </p>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      To reinstate your account, <strong>upload an updated COI immediately</strong>.
      Once a valid COI is uploaded and verified by our team, your account status
      will be restored and you can resume bidding.
    </p>
    <div style="background:#FFF7ED;border-left:4px solid #E07B00;padding:14px 18px;
                border-radius:0 6px 6px 0;margin:0 0 18px;">
      <p style="margin:0 0 8px;color:#0D1B2E;font-size:13px;font-weight:700;">
        COI Requirements
      </p>
      <p style="margin:0;color:#3D4F60;font-size:13px;line-height:1.7;">
        • $1,000,000 per occurrence / $2,000,000 aggregate (Commercial General Liability)<br />
        • Products-Completed Operations and Contractual Liability coverage included<br />
        • <strong>Stellar Edge Services LLC</strong> named as Additional Insured,
          primary and non-contributory
      </p>
    </div>`;

  const html = wrapEmail({
    heading: "Your COI has expired — bidding suspended",
    headingColor: "#DC2626",
    bodyHtml,
    ctaText: "Upload Updated COI to Reinstate Account",
    ctaUrl: COI_UPLOAD_URL,
    ctaColor: "#DC2626",
    mailgunDomain,
  });

  return { subject, text, html };
}

// ── WC CERTIFICATE EMAIL BUILDER ─────────────────────────────────────────────

export function buildWC30DayEmail(params: {
  contractorName: string;
  expiryDateDisplay: string;
  mailgunDomain: string;
}): { subject: string; text: string; html: string } {
  const { contractorName, expiryDateDisplay, mailgunDomain } = params;

  const subject = "Your Workers' Comp certificate expires in 30 days";

  const text = `Hi ${contractorName},

Your Workers' Compensation insurance certificate on file with Otter Quotes expires on ${expiryDateDisplay} — 30 days from now.

To avoid any interruption to your projects, please upload an updated certificate before that date.

Workers' Comp Requirements:
${WC_REQUIREMENTS}

Upload your updated certificate here:
${WC_UPLOAD_URL}

Questions? Reply to this email or call (844) 875-3412.

— The Otter Quotes Team

${footerPostalAddressText()}`;

  const bodyHtml = `
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Hi ${contractorName},
    </p>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Your Workers' Compensation insurance certificate on file with Otter Quotes expires on
      <strong>${expiryDateDisplay}</strong> — 30 days from now.
    </p>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      To avoid any interruption to your projects, please upload an updated certificate
      before that date.
    </p>
    <div style="background:#FFF7ED;border-left:4px solid #E07B00;padding:14px 18px;
                border-radius:0 6px 6px 0;margin:0 0 18px;">
      <p style="margin:0 0 8px;color:#0D1B2E;font-size:13px;font-weight:700;">
        Workers' Compensation Requirements
      </p>
      <p style="margin:0;color:#3D4F60;font-size:13px;line-height:1.7;">
        • Active, continuous Workers' Compensation coverage<br />
        • Covers all employees performing roofing-related work<br />
        • <strong>Stellar Edge Services LLC</strong> named as Certificate Holder
      </p>
    </div>`;

  const html = wrapEmail({
    heading: "Your Workers' Comp certificate expires in 30 days",
    bodyHtml,
    ctaText: "Upload Updated Certificate",
    ctaUrl: WC_UPLOAD_URL,
    mailgunDomain,
  });

  return { subject, text, html };
}
