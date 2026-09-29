// templates.ts (gh-1824 footer batch 4)
//
// Email HTML/text builders for notify-contractors, split out of index.ts so
// they can be unit-tested without importing index.ts (which calls `serve()`
// at module load time and would start listening for requests). Same
// convention as send-homeowner-next-steps/email-content.ts,
// send-message-notification/templates.ts (batch 2) and
// admin-contractor-action/templates.ts (batch 3).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export const DASHBOARD_URL = "https://otterquote.com/contractor-dashboard.html";
export const OPPORTUNITIES_URL = "https://otterquote.com/contractor-opportunities.html";
const SETTINGS_URL = "https://otterquote.com/contractor-settings.html";

/** Translate a job_type slug to a human-readable label. */
function jobTypeLabel(jobType: string): string {
  const map: Record<string, string> = {
    insurance_rcv: "Insurance Restoration (RCV)",
    insurance_acv: "Insurance Restoration (ACV)",
    retail_cash: "Retail / Cash",
    repair: "Repair",
  };
  return map[(jobType || "").toLowerCase()] || "Insurance Restoration";
}

/** Shared HTML footer used in all contractor emails. */
function emailFooter(): string {
  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
      &nbsp;&nbsp;|&nbsp;&nbsp;
      <a href="tel:+18448753412" style="color:#0EA5E9;text-decoration:none;">(844) 875-3412</a>
      <br><br>
      <a href="${SETTINGS_URL}" style="color:#94A3B8;font-size:12px;text-decoration:none;">Manage notification preferences</a>
      ${footerPostalAddressHtml()}
    </td>
  </tr>
</table>`.trim();
}

// ── Inlined from _shared/email.ts (#869) — see that file's header comment ──
// for why this is duplicated rather than imported (the EF body-deploy path
// does not resolve `_shared/` imports). Table-based CTA + MSO VML conditional
// so Outlook renders a real filled rectangle, not a bare link. Brand amber
// #E07B00 — replaces the non-brand #14B8A6 teal default AND every per-call
// accent override (navy/red/gold/green) this file used to hand-roll; the
// canonical helper is intentionally single-color so every CTA in the
// codebase reads as the same brand button (#869 AC 1/AC 3).
function emailButton({ href, label }: { href: string; label: string }): string {
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

/** Wrap any body HTML in the shared Otter Quotes email shell. */
function buildEmail(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <!-- Header -->
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Otter Quotes</span>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            ${bodyHtml}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td>${emailFooter()}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

// =============================================================================
// EMAIL BODY BUILDERS
// =============================================================================

/**
 * Email 1 — New Opportunity
 * Leads with trade + location, shows value prop, prominent CTA, auto-bid tip.
 */
export function newOpportunityEmailHtml(
  contractorName: string,
  city: string,
  state: string,
  tradeLabel: string,
  jobType: string
): string {
  const jLabel = jobTypeLabel(jobType);
  const tradeCap = tradeLabel.charAt(0).toUpperCase() + tradeLabel.slice(1);

  const body = `
    <p style="margin:0 0 6px;color:#64748B;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">New Opportunity</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">${tradeCap} Project &mdash; ${city}, ${state}</h2>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0F9FF;border-radius:8px;margin-bottom:20px;">
      <tr>
        <td style="padding:12px 16px;border-right:1px solid #BAE6FD;width:33%;">
          <p style="margin:0;color:#64748B;font-size:12px;">Trade</p>
          <p style="margin:4px 0 0;color:#0F172A;font-size:14px;font-weight:600;">${tradeCap}</p>
        </td>
        <td style="padding:12px 16px;border-right:1px solid #BAE6FD;width:33%;">
          <p style="margin:0;color:#64748B;font-size:12px;">Type</p>
          <p style="margin:4px 0 0;color:#0F172A;font-size:14px;font-weight:600;">${jLabel}</p>
        </td>
        <td style="padding:12px 16px;width:34%;">
          <p style="margin:0;color:#64748B;font-size:12px;">Location</p>
          <p style="margin:4px 0 0;color:#0F172A;font-size:14px;font-weight:600;">${city}, ${state}</p>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 6px;color:#374151;font-size:15px;">Hi ${contractorName},</p>
    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">A new opportunity is available in your service area. The winning contractor receives a fully executed contract, aerial measurements, and the homeowner&rsquo;s contact information &mdash; everything you need to schedule and start work.</p>

    ${emailButton({ href: OPPORTUNITIES_URL, label: "View Opportunity &rarr;" })}

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;margin-top:8px;">
      <tr>
        <td style="padding:14px 16px;">
          <p style="margin:0 0 4px;color:#92400E;font-size:14px;font-weight:600;">&#9889; Save time with Auto-Bid</p>
          <p style="margin:0;color:#78350F;font-size:13px;line-height:1.5;">Enable Auto-Bid in Settings and you&rsquo;ll automatically compete for every matching project &mdash; no manual action needed between jobs.</p>
        </td>
      </tr>
    </table>
  `;

  return buildEmail(body);
}

/**
 * Plain-text fallback for Email 1 (new_opportunity).
 */
export function newOpportunityEmailText(
  contractorName: string,
  city: string,
  state: string,
  tradeLabel: string,
  jobType: string
): string {
  const jLabel = jobTypeLabel(jobType);
  return `Hi ${contractorName},

New ${tradeLabel} project in ${city}, ${state} (${jLabel}).

The winning contractor receives a fully executed contract, aerial measurements, and the homeowner's contact information — ready to schedule and start work.

View opportunity:
${OPPORTUNITIES_URL}

Tip: Enable Auto-Bid in Settings to automatically compete for every matching project without manual action.
${SETTINGS_URL}

---
support@otterquote.com | (844) 875-3412
Manage preferences: ${SETTINGS_URL}

${footerPostalAddressText()}`;
}

/**
 * Email 2 — Contract Signed / Project Package Ready
 */
export function contractSignedEmailHtml(contractorName: string, claimId: string): string {
  const body = `
    <p style="margin:0 0 6px;color:#14B8A6;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Contract Signed</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Your Project Package Is Ready</h2>

    <p style="margin:0 0 6px;color:#374151;font-size:15px;">Hi ${contractorName},</p>
    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">Both parties have signed the contract. Your complete project package is waiting in your dashboard.</p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 10px;color:#166534;font-size:14px;font-weight:700;">What&rsquo;s included:</p>
        <table cellpadding="0" cellspacing="0" border="0">
          <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">&#10003;&nbsp; Fully executed contract</td></tr>
          <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">&#10003;&nbsp; Insurance loss sheet with AI-parsed summary</td></tr>
          <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">&#10003;&nbsp; Trade-specific aerial measurements</td></tr>
          <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">&#10003;&nbsp; Material and color selections</td></tr>
          <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">&#10003;&nbsp; Homeowner contact information (released now)</td></tr>
        </table>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FEF9C3;border:1px solid #FDE68A;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:12px 16px;">
        <p style="margin:0;color:#92400E;font-size:14px;font-weight:600;">&#9201; 48-hour window</p>
        <p style="margin:4px 0 0;color:#78350F;font-size:13px;">You have 48 hours to make initial contact with the homeowner. Log in now to view their information.</p>
      </td></tr>
    </table>

    ${emailButton({ href: DASHBOARD_URL, label: "Go to My Dashboard &rarr;" })}
  `;

  return buildEmail(body);
}

export function contractSignedEmailText(contractorName: string): string {
  return `Hi ${contractorName},

Both parties have signed your contract. Your complete project package is ready in your Otter Quotes dashboard.

What's included:
- Fully executed contract
- Insurance loss sheet with AI-parsed summary
- Trade-specific aerial measurements
- Material and color selections
- Homeowner contact information (released now)

You have 48 hours to make initial contact with the homeowner.

Log in to view your project package:
${DASHBOARD_URL}

---
support@otterquote.com | (844) 875-3412

${footerPostalAddressText()}`;
}

/**
 * Email 2b — Bid Accepted (gh-1293 criterion 3b)
 *
 * Sent to the winning contractor the moment a homeowner accepts their bid
 * (log_bid_accepted() already writes a channel:'dashboard' `notifications`
 * row for this same event -- this is the channel:'email' counterpart, the
 * one contractor-settings.html's "Bid accepted by homeowner" toggle promised
 * and nothing sent). Distinct from contractSignedEmailHtml (Email 2), which
 * fires later, after BOTH parties have signed -- this one fires first, at
 * selection, and its job is to prompt the contractor to go sign.
 */
export function bidAcceptedEmailHtml(contractorName: string, address: string, amountStr: string | null): string {
  const amountLine = amountStr
    ? `<p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">Bid amount: <strong>${amountStr}</strong></p>`
    : "";

  const body = `
    <p style="margin:0 0 6px;color:#15803D;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Bid Accepted</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">You Won the Bid</h2>

    <p style="margin:0 0 6px;color:#374151;font-size:15px;">Hi ${contractorName},</p>
    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">The homeowner at <strong>${address}</strong> selected your bid.</p>
    ${amountLine}

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#DCFCE7;border:1px solid #BBF7D0;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:14px 16px;">
        <p style="margin:0;color:#15803D;font-size:14px;font-weight:600;">Next step: sign the contract</p>
        <p style="margin:4px 0 0;color:#166534;font-size:13px;line-height:1.5;">You sign first. Once your signature is on file, the homeowner is prompted to countersign and the project moves forward.</p>
      </td></tr>
    </table>

    ${emailButton({ href: DASHBOARD_URL, label: "Go to My Dashboard &rarr;" })}
  `;

  return buildEmail(body);
}

export function bidAcceptedEmailText(contractorName: string, address: string, amountStr: string | null): string {
  const amountLine = amountStr ? `Bid amount: ${amountStr}\n\n` : "";
  return `Hi ${contractorName},

The homeowner at ${address} selected your bid.

${amountLine}Next step: sign the contract. You sign first — once your signature is on file, the homeowner is prompted to countersign and the project moves forward.

Log in to sign:
${DASHBOARD_URL}

---
support@otterquote.com | (844) 875-3412

${footerPostalAddressText()}`;
}

/**
 * Email 3 — Bid Update Confirmed
 */
export function bidUpdateEmailHtml(contractorName: string): string {
  const body = `
    <p style="margin:0 0 6px;color:#64748B;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Bid Update</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Bid Update Confirmed</h2>

    <p style="margin:0 0 6px;color:#374151;font-size:15px;">Hi ${contractorName},</p>
    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">Your updated bid has been saved. The homeowner has been notified and will see your revised figures when they review their options.</p>

    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">You can update your bid any time before the homeowner makes a selection.</p>

    ${emailButton({ href: DASHBOARD_URL, label: "View My Dashboard &rarr;" })}
  `;

  return buildEmail(body);
}

export function bidUpdateEmailText(contractorName: string): string {
  return `Hi ${contractorName},

Your updated bid has been saved. The homeowner has been notified and will see your revised figures when they review their options.

You can update your bid any time before the homeowner makes a selection.

Log in to your dashboard:
${DASHBOARD_URL}

---
support@otterquote.com | (844) 875-3412

${footerPostalAddressText()}`;
}

/**
 * Email 4 — Agreement Requested
 * Urgency-driven: homeowner is ready to select, contractor just needs to sign.
 */
export function agreementRequestedEmailHtml(
  contractorName: string,
  displayLocation: string,
  signingLink: string
): string {
  const body = `
    <p style="margin:0 0 6px;color:#DC2626;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Action Required</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">A Homeowner Is Ready to Select You</h2>

    <p style="margin:0 0 6px;color:#374151;font-size:15px;">Hi ${contractorName},</p>
    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">A homeowner reviewing bids for a project in <strong>${displayLocation}</strong> wants to work with you &mdash; but they can&rsquo;t select you until you sign your contractor agreement.</p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:14px 16px;">
        <p style="margin:0;color:#991B1B;font-size:14px;font-weight:600;">Contractors who sign promptly get selected first.</p>
        <p style="margin:6px 0 0;color:#7F1D1D;font-size:13px;">Slower contractors lose to competitors who are ready. This takes about 2 minutes.</p>
      </td></tr>
    </table>

    ${emailButton({ href: signingLink, label: "Sign My Agreement Now &rarr;" })}

    <p style="margin:16px 0 0;color:#6B7280;font-size:13px;">This link takes you directly to your agreement signing page and keeps your bid active.</p>
  `;

  return buildEmail(body);
}

export function agreementRequestedEmailText(
  contractorName: string,
  displayLocation: string,
  signingLink: string
): string {
  return `Hi ${contractorName},

A homeowner reviewing bids for a project in ${displayLocation} is interested in working with you.

To be selected, you need to sign your contractor agreement. Contractors who sign promptly get selected first — slower contractors lose to competitors who are ready.

Sign your agreement now:
${signingLink}

This takes about 2 minutes and keeps your bid active.

---
support@otterquote.com | (844) 875-3412

${footerPostalAddressText()}`;
}

/**
 * Email 5 — Bid Expired
 * Sent when a bid reaches its 14-day window without auto-renew.
 */
export function bidExpiredEmailHtml(
  contractorName: string,
  location: string,
  tradeCap: string,
  quoteId: string,
  claimId: string,
  mailgunDomain: string
): string {
  const renewUrl = `https://otterquote.com/contractor-bid-form.html?renew=true&quote_id=${encodeURIComponent(quoteId)}&claim_id=${encodeURIComponent(claimId)}`;
  const body = `
    <p style="margin:0 0 6px;color:#D97706;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Bid Update</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Your Bid Has Expired</h2>

    <p style="margin:0 0 6px;color:#374151;font-size:15px;">Hi ${contractorName},</p>
    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">Your <strong>${tradeCap}</strong> bid for the project in <strong>${location}</strong> has passed its 14-day validity window. The homeowner is still reviewing options &mdash; you can renew your bid in one click to stay in the running.</p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:14px 16px;">
        <p style="margin:0;color:#92400E;font-size:14px;font-weight:600;">Renewing re-submits your existing bid with a fresh 14-day window.</p>
        <p style="margin:6px 0 0;color:#78350F;font-size:13px;">You can adjust your price before confirming if needed.</p>
      </td></tr>
    </table>

    ${emailButton({ href: renewUrl, label: "Renew My Bid &rarr;" })}

    <p style="margin:16px 0 0;color:#6B7280;font-size:13px;">Don&rsquo;t want renewal reminders? Update your <a href="https://otterquote.com/contractor-settings.html" style="color:#0369A1;">notification preferences</a>.</p>
  `;
  return buildEmail(body);
}

export function bidExpiredEmailText(contractorName: string, location: string, tradeCap: string, quoteId: string, claimId: string): string {
  const renewUrl = `https://otterquote.com/contractor-bid-form.html?renew=true&quote_id=${encodeURIComponent(quoteId)}&claim_id=${encodeURIComponent(claimId)}`;
  return `Hi ${contractorName},

Your ${tradeCap} bid for the project in ${location} has passed its 14-day validity window. The homeowner is still reviewing options.

Renew your bid in one click to stay in the running:
${renewUrl}

Renewing re-submits your existing bid with a fresh 14-day window. You can adjust your price before confirming if needed.

---
support@otterquote.com | (844) 875-3412

${footerPostalAddressText()}`;
}

/**
 * Email 6 — Bid Renewal Requested (confirmation)
 * Sent when a contractor manually renews a bid from the dashboard or bid form.
 */
export function bidRenewalRequestedEmailHtml(
  contractorName: string,
  location: string,
  tradeCap: string
): string {
  const body = `
    <p style="margin:0 0 6px;color:#059669;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Bid Renewed</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Your Bid Has Been Renewed</h2>

    <p style="margin:0 0 6px;color:#374151;font-size:15px;">Hi ${contractorName},</p>
    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">Your <strong>${tradeCap}</strong> bid for the project in <strong>${location}</strong> is active again. The homeowner will see your bid for another 14 days.</p>

    <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">You can update your bid details at any time before the homeowner makes a selection.</p>

    ${emailButton({ href: DASHBOARD_URL, label: "View My Dashboard &rarr;" })}
  `;
  return buildEmail(body);
}

export function bidRenewalRequestedEmailText(contractorName: string, location: string, tradeCap: string): string {
  return `Hi ${contractorName},

Your ${tradeCap} bid for the project in ${location} is active again. The homeowner will see your bid for another 14 days.

You can update your bid details at any time before the homeowner makes a selection.

Log in to your dashboard:
${DASHBOARD_URL}

---
support@otterquote.com | (844) 875-3412

${footerPostalAddressText()}`;
}
