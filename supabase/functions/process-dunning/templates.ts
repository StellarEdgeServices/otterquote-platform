// templates.ts (gh-1824 footer batch 6)
//
// Email bodies for process-dunning (contractor payment-declined reminders and
// final notice, homeowner choice email, contractor outcome emails, and the admin
// alert bodies), plus the HTML -> text/plain converter, split out of index.ts so
// they can be unit-tested without importing index.ts (which calls serve() at
// module load time). Pure functions: no I/O, no clock. Wording is moved
// verbatim from index.ts; templates.test.ts pins every rendered body with
// exact-equality goldens. The D-237 postal footer is NOT added here: index.ts's
// sendEmail() appends it via footer-append.ts, and the goldens compose the same
// way.

export const PLATFORM_URL = "https://otterquote.com";
export const SETTINGS_URL = `${PLATFORM_URL}/contractor-settings.html`;

// #869 AC 5: `text` derives generically from `html` via htmlToPlainText() when
// the caller of sendEmail() doesn't supply one.
// gh-1020 (CodeQL js/incomplete-multi-character-sanitization): a single
// non-recursive `<[^>]+>` pass can leave residual "<script"-shaped text
// behind on malformed/nested markup. Looping to a fixed point closes that.
function stripTags(input: string): string {
  let prev: string;
  let out = input;
  do {
    prev = out;
    out = prev.replace(/<[^>]+>/g, "");
  } while (out !== prev);
  return out;
}

export function htmlToPlainText(html: string): string {
  const withoutTags = html
    // `<a href="URL" ...>LABEL</a>` -> "LABEL: URL" — per #869 AC 2, the
    // text part deliberately KEEPS the bare URL (accessibility / HTML-blocked
    // fallback); this is the one place a bare URL belongs.
    .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const cleanLabel = stripTags(label).replace(/\s+/g, " ").trim();
      return cleanLabel ? `${cleanLabel}: ${href}` : href;
    })
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n");

  return stripTags(withoutTags)
    // gh-1020 (CodeQL js/double-escaping-or-unescaping): decode named
    // entities and &lt;/&gt; BEFORE &amp; — decoding &amp; first would let a
    // double-encoded "&amp;lt;script&amp;gt;" resolve into a literal
    // "<script>" once &lt;/&gt; ran, in text meant to be plain/safe.
    .replace(/&rsquo;|&#39;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    // Collapse runs of blank lines (including ones that only became blank
    // after trimming indentation whitespace) down to a single blank line.
    .filter((line, i, arr) => line !== "" || arr[i - 1] !== "")
    .join("\n")
    .trim();
}

// ── HTML email templates ──

export function emailWrapper(headerBg: string, headerColor: string, title: string, body: string): string {
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:${headerBg};padding:20px;border-radius:8px 8px 0 0;text-align:center;">
    <img src="${PLATFORM_URL}/img/otter-logo.svg" alt="Otter Quotes" style="width:40px;height:40px;">
    <h1 style="color:${headerColor};font-size:18px;margin:10px 0 0;">${title}</h1>
  </div>
  <div style="background:#ffffff;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px;">
    ${body}
    <p style="color:#6B7280;font-size:13px;margin-top:20px;">Questions? Contact us at support@otterquote.com</p>
  </div>
</div>`.trim();
}

export function hourlyReminderEmail(companyName: string): string {
  return emailWrapper(
    "#0B1929", "#F59E0B", "Payment Action Required",
    `<p>Hi ${companyName},</p>
     <p>You have a signed contract waiting for you, but your payment method has been declined.
     Please <a href="${SETTINGS_URL}" style="color:#0369A1;font-weight:600;">click here</a> to resolve the matter.</p>
     <a href="${SETTINGS_URL}"
        style="display:inline-block;background:#F59E0B;color:#0B1929;padding:12px 24px;
               border-radius:6px;text-decoration:none;font-weight:600;margin-top:12px;">
       Update Payment Method
     </a>`
  );
}

export function warningEmail(companyName: string): string {
  return emailWrapper(
    "#7F1D1D", "#FCA5A5", "Final Notice — Payment Declined",
    `<p>Hi ${companyName},</p>
     <p>You have a signed contract waiting for you, but your payment method has been declined.</p>
     <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:16px;margin:16px 0;">
       <p style="color:#991B1B;font-weight:600;margin:0 0 8px;">What happens at 10 a.m. today:</p>
       <p style="color:#7F1D1D;margin:0;">
         We will inform the client of the payment failure and give them the option to choose
         another contractor. If they opt to move forward with you, you will receive their
         information and be liable for all fees, a $250 nonpayment fee, and any attorney's
         fees and costs associated with collecting this amount.
       </p>
     </div>
     <a href="${SETTINGS_URL}"
        style="display:inline-block;background:#DC2626;color:#ffffff;padding:12px 24px;
               border-radius:6px;text-decoration:none;font-weight:600;margin-top:8px;">
       Resolve Now — Update Payment Method
     </a>`
  );
}

export function homeownerNotificationEmail(
  homeownerName: string,
  contractorName: string,
  failureId: string,
  supabaseUrl: string
): string {
  const proceedUrl  = `${supabaseUrl}/functions/v1/process-dunning?mode=homeowner_choice&failure_id=${failureId}&choice=proceed`;
  const differentUrl = `${supabaseUrl}/functions/v1/process-dunning?mode=homeowner_choice&failure_id=${failureId}&choice=different`;

  return emailWrapper(
    "#0B1929", "#14B8A6", "Important Update on Your Project",
    `<p>Hi ${homeownerName},</p>
     <p>The payment method your contractor has on file with us has been declined.
     Contractors typically charge thousands of dollars to their credit cards for materials
     every day. So this is probably just an oversight on their part. But there is a small
     chance that this could be a sign of financial concerns. We have not sent your contact
     information to this contractor.</p>
     <p>At this time, you have the option to move forward with the contractor you have
     selected or select another contractor for your project.</p>
     <div style="margin:24px 0;display:flex;gap:12px;flex-wrap:wrap;">
       <a href="${proceedUrl}"
          style="display:inline-block;background:#14B8A6;color:#ffffff;padding:14px 28px;
                 border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;">
         Move Forward with ${contractorName}
       </a>
       &nbsp;&nbsp;
       <a href="${differentUrl}"
          style="display:inline-block;background:#6B7280;color:#ffffff;padding:14px 28px;
                 border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;">
         Choose a Different Contractor
       </a>
     </div>`
  );
}

export function contractorLostProjectEmail(companyName: string): string {
  return emailWrapper(
    "#0B1929", "#EF4444", "Project Update",
    `<p>Hi ${companyName},</p>
     <p>The homeowner on your pending project has chosen to select a different contractor
     due to the unresolved payment issue on their file.</p>
     <p>Please update your payment method at <a href="${SETTINGS_URL}">${SETTINGS_URL}</a>
     to ensure this doesn't happen on future projects.</p>`
  );
}

export function contractorProceedEmail(companyName: string): string {
  return emailWrapper(
    "#0B1929", "#14B8A6", "Homeowner Chose to Move Forward",
    `<p>Hi ${companyName},</p>
     <p>The homeowner has elected to move forward with you as their contractor.</p>
     <p><strong>Important:</strong> By continuing, you are liable for all platform fees,
     a $250 nonpayment fee, and any attorney's fees and costs associated with collecting
     this amount from you, in addition to the original platform fee.</p>
     <p>Please update your payment method immediately at <a href="${SETTINGS_URL}">${SETTINGS_URL}</a>.
     The homeowner's contact information will be released to you shortly.</p>`
  );
}

export function adminAlertEmail(subject: string, body: string): string {
  return `<div style="font-family:monospace;padding:20px;"><h2>${subject}</h2>${body}</div>`;
}

/** Admin (Dustin) dunning alert body: Homeowner Chose to Proceed. */
export function proceededAdminAlertEmail(failId: string, companyName: string, contractorId: string, claimLabel: string, amountCents: number): string {
  return adminAlertEmail("Homeowner Chose to Proceed", `
            <p><strong>Failure ID:</strong> ${failId}</p>
            <p><strong>Contractor:</strong> ${companyName} (${contractorId})</p>
            <p><strong>Claim:</strong> ${claimLabel}</p>
            <p><strong>Amount owed:</strong> $${(amountCents / 100).toFixed(2)} platform fee + $250 nonpayment fee + attorney's fees</p>
            <p><strong>Action needed:</strong> Manually collect fees and release homeowner contact info.</p>
          `);
}

/** Admin (Dustin) dunning alert body: Homeowner Chose Different Contractor. */
export function differentContractorAdminAlertEmail(failId: string, companyName: string, contractorId: string, claimLabel: string): string {
  return adminAlertEmail("Homeowner Chose Different Contractor", `
            <p><strong>Failure ID:</strong> ${failId}</p>
            <p><strong>Contractor:</strong> ${companyName} (${contractorId})</p>
            <p><strong>Claim:</strong> ${claimLabel}</p>
            <p><strong>Result:</strong> Claim reset to bidding. Contractor notified.</p>
          `);
}

/** Admin (Dustin) dunning alert body: Homeowner Notified (10 AM). */
export function homeownerNotifiedAdminAlertEmail(failId: string, companyName: string, contractorId: string, claimLabel: string, amountCents: number, reminderCount: number): string {
  return adminAlertEmail("Homeowner Notified (10 AM)", `
          <p><strong>Failure ID:</strong> ${failId}</p>
          <p><strong>Contractor:</strong> ${companyName} (${contractorId})</p>
          <p><strong>Claim:</strong> ${claimLabel}</p>
          <p><strong>Amount:</strong> $${(amountCents / 100).toFixed(2)}</p>
          <p><strong>Reminders sent:</strong> ${reminderCount}</p>
          <p>Homeowner has been emailed with two CTAs. Waiting for their choice.</p>
        `);
}
