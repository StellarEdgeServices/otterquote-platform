// templates.ts (gh-1824 footer batch 6)
//
// Email bodies (text + HTML) for docusign-webhook's two Mailgun sends, split
// out of index.ts so they can be unit-tested without importing index.ts (which
// calls serve() at module load time and would start listening for requests).
// Pure functions: no I/O, no clock. Wording is moved verbatim from index.ts;
// templates.test.ts pins every rendered body with exact-equality goldens.

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824 D-237

/** D-149 immediate counter-sign nudge to the contractor: plain-text body. */
export function counterSignNudgeText(
  nudgeName: string,
  nudgeAddress: string,
  nudgeJobNumber: string,
  contractorDashboardUrl: string,
): string {
  return `Hi ${nudgeName},\n\n` +
    `Good news — the homeowner has signed the contract for ${nudgeAddress} (${nudgeJobNumber}).\n\n` +
    `The contract is now waiting on your counter-signature. Once you sign, the agreement is fully executed and the project can move forward.\n\n` +
    `Counter-sign from your dashboard:\n${contractorDashboardUrl}\n\n` +
    `We'll send you a reminder every couple of hours during business hours until the contract is fully executed.\n\n` +
    `Questions? Reply to this email or call (844) 875-3412.\n\n` +
    `— The Otter Quotes Team\n\n${footerPostalAddressText()}`;
}

/** D-149 immediate counter-sign nudge to the contractor: HTML body. */
export function counterSignNudgeHtml(
  nudgeName: string,
  nudgeAddress: string,
  nudgeJobNumber: string,
  contractorDashboardUrl: string,
): string {
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">` +
    `<p>Hi ${nudgeName},</p>` +
    `<p>Good news — the homeowner has signed the contract for <strong>${nudgeAddress}</strong> (${nudgeJobNumber}).</p>` +
    `<p>The contract is now waiting on <strong>your counter-signature</strong>. Once you sign, the agreement is fully executed and the project can move forward.</p>` +
    `<p><a href="${contractorDashboardUrl}" style="color:#0066cc;">Counter-sign from your dashboard</a></p>` +
    `<p>We'll send you a reminder every couple of hours during business hours until the contract is fully executed.</p>` +
    `<p>Questions? Reply to this email or call (844) 875-3412.</p>` +
    `<p>— The Otter Quotes Team</p>${footerPostalAddressHtml()}</body></html>`;
}

/** D-225 C5 homeowner "contract is signed" email: plain-text body. */
export function homeownerContractSignedText(
  homeownerName: string,
  contractorCompany: string,
  propertyAddress: string,
  jobNumber: string,
  dashboardUrl: string,
): string {
  return `Hi ${homeownerName},\n\n` +
    `Great news — your contract with ${contractorCompany} for ${propertyAddress} is fully executed.\n\n` +
    `${jobNumber}\n\n` +
    `What happens next:\n` +
    `• ${contractorCompany} will contact you within 48 hours to coordinate next steps.\n` +
    `• You can track your project status anytime on your dashboard: ${dashboardUrl}\n\n` +
    `Questions? Reply to this email or contact support@otterquote.com.\n\n` +
    `— The Otter Quotes Team\n\n${footerPostalAddressText()}`;
}

/** D-225 C5 homeowner "contract is signed" email: HTML body. */
export function homeownerContractSignedHtml(
  homeownerName: string,
  contractorCompany: string,
  propertyAddress: string,
  jobNumber: string,
  dashboardUrl: string,
): string {
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">` +
    `<p>Hi ${homeownerName},</p>` +
    `<p>Great news — your contract with <strong>${contractorCompany}</strong> for <strong>${propertyAddress}</strong> is fully executed.</p>` +
    `<p style="font-size:1.05rem;font-weight:bold;color:#0066cc;">${jobNumber}</p>` +
    `<p><strong>What happens next:</strong></p>` +
    `<ul><li>${contractorCompany} will contact you within 48 hours to coordinate next steps.</li>` +
    `<li>You can track your project status anytime on your <a href="${dashboardUrl}" style="color:#0066cc;">dashboard</a>.</li></ul>` +
    `<p>Questions? Reply to this email or contact <a href="mailto:support@otterquote.com">support@otterquote.com</a>.</p>` +
    `<p>— The Otter Quotes Team</p>${footerPostalAddressHtml()}</body></html>`;
}
