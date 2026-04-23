/**
 * OtterQuote Edge Function: process-coi-reminders
 *
 * D-170 — Nightly COI Expiry Reminder System
 *
 * Invoked daily at 8:00 AM via pg_cron (schedule: "0 8 * * *").
 * May also be manually POST-ed with an optional { "contractor_id": "..." }
 * body to scope to a single contractor — useful for testing.
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 *
 * Queries all active contractors where coi_expires_at IS NOT NULL.
 * For each, calculates days until expiry and sends Mailgun reminder emails
 * at the 30, 14, and 7-day marks — exactly once per window, enforced by
 * the idempotency timestamp columns added in SQL v46:
 *   - coi_reminder_30_sent_at   (set when 30-day reminder fires)
 *   - coi_reminder_14_sent_at   (set when 14-day reminder fires)
 *   - coi_reminder_7_sent_at    (set when 7-day reminder fires)
 *
 * On expiry (coi_expires_at <= CURRENT_DATE):
 *   - Sends "COI has expired — bidding suspended" notice.
 *   - Sets coi_expired_notified_at = NOW() (send-once guard).
 *   - Sets contractors.status = 'suspended'.
 *     NOTE: 'coi_expired' is not in the contractors_status_check constraint
 *     (added v10, corrected v34: pending_approval | active | suspended | inactive).
 *     'suspended' is the correct status — contractor_can_bid() also independently
 *     gates bidding by checking coi_expires_at > CURRENT_DATE, so both layers fire.
 *
 * ── COI requirements included in all email copy ──────────────────────────────
 *   - $1,000,000 per occurrence / $2,000,000 aggregate (CGL)
 *   - Products-Completed Operations and Contractual Liability coverage
 *   - Stellar Edge Services LLC named as Additional Insured,
 *     primary and non-contributory
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 *   Each reminder column is a one-way latch: once set, it is never cleared.
 *   A contractor who renews their COI will have a new coi_expires_at date,
 *   but the reminder columns remain set from the prior cycle — that is correct
 *   because the reminders for that expiry cycle were already sent. Fresh
 *   reminder columns are not needed until the next renewal triggers a new expiry.
 *   Exception: if admin needs to re-send manually, they can null out the columns.
 *
 * ── Rate limiting ────────────────────────────────────────────────────────────
 *   Uses check_rate_limit() RPC against rate_limit_config.
 *   Caller ID: 'cron' (function-level guard — not per-contractor).
 *   Configured in v50 SQL migration.
 *
 * ── Auth ─────────────────────────────────────────────────────────────────────
 *   No JWT required — invoked by pg_cron using service role bearer token.
 *   CORS set to ALLOWED_ORIGINS allowlist (defense-in-depth; cron doesn't use it).
 *
 * ── Env vars required ────────────────────────────────────────────────────────
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN
 *
 * ── Returns ──────────────────────────────────────────────────────────────────
 *   {
 *     reminded30: N,   // 30-day reminders sent this run
 *     reminded14: N,   // 14-day reminders sent this run
 *     reminded7: N,    // 7-day reminders sent this run
 *     expired: N,      // expired notices sent + status set to suspended
 *     skipped: N,      // contractors with no email / invalid data
 *     errors: [...],   // non-fatal per-contractor errors
 *     elapsedMs: N,
 *     ranAt: "..."
 *   }
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// =============================================================================
// CONSTANTS
// =============================================================================

const FUNCTION_NAME = "process-coi-reminders";

// CORS allowlist — cron doesn't use CORS, but defense-in-depth for any
// browser-side calls (e.g., Dustin manually triggering from devtools).
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
];

// Upload CTA destination for all reminder emails.
const COI_UPLOAD_URL =
  "https://otterquote.com/contractor-settings.html?reason=coi_required#coiCard";

// CGL requirement copy — used in every email so contractors always know
// exactly what coverage they need to upload.
const COI_REQUIREMENTS = `
  • $1,000,000 per occurrence / $2,000,000 aggregate (Commercial General Liability)
  • Products-Completed Operations and Contractual Liability coverage included
  • Stellar Edge Services LLC named as Additional Insured, primary and non-contributory
`.trim();

// =============================================================================
// CORS HELPER
// =============================================================================

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Vary": "Origin",
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  corsHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// =============================================================================
// MAILGUN HELPER
// =============================================================================

async function sendMailgunEmail(
  apiKey: string,
  domain: string,
  to: string,
  from: string,
  subject: string,
  text: string,
  html: string
): Promise<boolean> {
  const basicAuth = btoa(`api:${apiKey}`);
  const formData = new URLSearchParams();
  formData.append("from", from);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", text);
  formData.append("html", html);

  try {
    const response = await fetch(
      `https://api.mailgun.net/v3/${domain}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Basic ${basicAuth}` },
        body: formData,
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(
        `[${FUNCTION_NAME}] Mailgun error (${response.status}):`,
        errText.substring(0, 200)
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Mailgun fetch threw:`, err);
    return false;
  }
}

// =============================================================================
// DATE HELPER
// =============================================================================

/**
 * Returns the number of calendar days between today (UTC) and a DATE string
 * (YYYY-MM-DD). Positive = future, 0 = today, negative = past.
 */
function daysUntilExpiry(coiExpiresAt: string): number {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const expiry = new Date(coiExpiresAt + "T00:00:00Z");
  return Math.round((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

// =============================================================================
// EMAIL BUILDERS
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
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── 30-day reminder ──────────────────────────────────────────────────────────

function build30DayEmail(params: {
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

— The Otter Quotes Team`;

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

// ── 14-day reminder ──────────────────────────────────────────────────────────

function build14DayEmail(params: {
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

— The Otter Quotes Team`;

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

// ── 7-day reminder ───────────────────────────────────────────────────────────

function build7DayEmail(params: {
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

— The Otter Quotes Team`;

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

// ── Expired notice ────────────────────────────────────────────────────────────

function buildExpiredEmail(params: {
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

— The Otter Quotes Team`;

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

// =============================================================================
// MAIN PROCESSING LOGIC
// =============================================================================

interface ProcessResult {
  reminded30: number;
  reminded14: number;
  reminded7: number;
  expired: number;
  skipped: number;
  errors: string[];
  elapsedMs: number;
  ranAt: string;
}

async function processCOIReminders(
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  scopeContractorId?: string
): Promise<ProcessResult> {
  const result: ProcessResult = {
    reminded30: 0,
    reminded14: 0,
    reminded7: 0,
    expired: 0,
    skipped: 0,
    errors: [],
    elapsedMs: 0,
    ranAt: new Date().toISOString(),
  };

  const now = new Date().toISOString();
  const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;

  // ── Fetch candidates ──────────────────────────────────────────────────────
  // Query active contractors with a COI expiry date on file.
  // We also pull suspended contractors whose COI may have just been renewed
  // (they'd need to be re-activated by admin, but we won't re-notify them here).
  let query = supabase
    .from("contractors")
    .select(
      `id, contact_name, email, notification_emails, status,
       coi_expires_at,
       coi_reminder_30_sent_at, coi_reminder_14_sent_at,
       coi_reminder_7_sent_at, coi_expired_notified_at`
    )
    .eq("status", "active")
    .not("coi_expires_at", "is", null);

  if (scopeContractorId) {
    query = query.eq("id", scopeContractorId);
  }

  const { data: contractors, error: fetchError } = await query;

  if (fetchError) {
    console.error(`[${FUNCTION_NAME}] Fetch error:`, fetchError.message);
    result.errors.push(`Fetch failed: ${fetchError.message}`);
    return result;
  }

  if (!contractors || contractors.length === 0) {
    console.log(`[${FUNCTION_NAME}] No active contractors with COI dates found.`);
    return result;
  }

  console.log(
    `[${FUNCTION_NAME}] Processing ${contractors.length} contractor(s).`
  );

  for (const contractor of contractors) {
    const contractorId = contractor.id;
    const name = contractor.contact_name || "Contractor";
    const coiDate = contractor.coi_expires_at as string;

    // Build recipient list (primary + notification emails)
    const recipients: string[] = [];
    if (contractor.email) recipients.push(contractor.email);
    if (Array.isArray(contractor.notification_emails)) {
      for (const e of contractor.notification_emails) {
        if (e && !recipients.includes(e)) recipients.push(e);
      }
    }

    if (recipients.length === 0) {
      console.warn(
        `[${FUNCTION_NAME}] Contractor ${contractorId} has no email — skipped.`
      );
      result.skipped++;
      continue;
    }

    const days = daysUntilExpiry(coiDate);

    // Human-readable date for email copy
    const expiryDateDisplay = new Date(coiDate + "T00:00:00Z").toLocaleDateString(
      "en-US",
      { month: "long", day: "numeric", year: "numeric" }
    );

    console.log(
      `[${FUNCTION_NAME}] Contractor ${contractorId} (${name}): ` +
        `COI expires ${coiDate} (${days} days)`
    );

    // ── EXPIRED PATH ────────────────────────────────────────────────────────
    // days <= 0 means expiry date is today or in the past.
    if (days <= 0) {
      if (contractor.coi_expired_notified_at) {
        console.log(
          `[${FUNCTION_NAME}] Contractor ${contractorId}: expired notice already sent — skipping.`
        );
        continue;
      }

      // 1. Suspend the contractor
      const { error: suspendError } = await supabase
        .from("contractors")
        .update({
          status: "suspended",
          coi_expired_notified_at: now,
        })
        .eq("id", contractorId);

      if (suspendError) {
        const msg = `Contractor ${contractorId}: suspend update failed — ${suspendError.message}`;
        console.error(`[${FUNCTION_NAME}] ${msg}`);
        result.errors.push(msg);
        continue;
      }

      // 2. Send expired notice
      const expiredEmail = buildExpiredEmail({
        contractorName: name,
        expiredDateDisplay: expiryDateDisplay,
        mailgunDomain,
      });

      let emailOk = false;
      for (const recipient of recipients) {
        const sent = await sendMailgunEmail(
          mailgunApiKey,
          mailgunDomain,
          recipient,
          fromAddress,
          expiredEmail.subject,
          expiredEmail.text,
          expiredEmail.html
        );
        if (sent) emailOk = true;
      }

      if (!emailOk) {
        result.errors.push(
          `Contractor ${contractorId}: expired email failed to send (account suspended; status updated)`
        );
      }

      result.expired++;
      console.log(
        `[${FUNCTION_NAME}] Contractor ${contractorId}: COI expired — suspended + notified.`
      );
      continue;
    }

    // ── UPCOMING REMINDER PATHS ─────────────────────────────────────────────
    // Each reminder fires independently — a contractor coming in late
    // (e.g., already at 6 days) will receive all three unsent reminders.
    // Each is guarded by its own timestamp column.

    // 7-day reminder (≤7 days until expiry)
    if (days <= 7 && !contractor.coi_reminder_7_sent_at) {
      const email7 = build7DayEmail({
        contractorName: name,
        expiryDateDisplay,
        mailgunDomain,
      });

      let sent7 = false;
      for (const recipient of recipients) {
        const ok = await sendMailgunEmail(
          mailgunApiKey,
          mailgunDomain,
          recipient,
          fromAddress,
          email7.subject,
          email7.text,
          email7.html
        );
        if (ok) sent7 = true;
      }

      if (sent7) {
        const { error: stampError } = await supabase
          .from("contractors")
          .update({ coi_reminder_7_sent_at: now })
          .eq("id", contractorId);

        if (stampError) {
          result.errors.push(
            `Contractor ${contractorId}: 7-day stamp failed — ${stampError.message}`
          );
        } else {
          result.reminded7++;
          console.log(
            `[${FUNCTION_NAME}] Contractor ${contractorId}: 7-day reminder sent.`
          );
        }
      } else {
        result.errors.push(
          `Contractor ${contractorId}: 7-day email failed to send.`
        );
      }
    }

    // 14-day reminder (≤14 days until expiry)
    if (days <= 14 && !contractor.coi_reminder_14_sent_at) {
      const email14 = build14DayEmail({
        contractorName: name,
        expiryDateDisplay,
        mailgunDomain,
      });

      let sent14 = false;
      for (const recipient of recipients) {
        const ok = await sendMailgunEmail(
          mailgunApiKey,
          mailgunDomain,
          recipient,
          fromAddress,
          email14.subject,
          email14.text,
          email14.html
        );
        if (ok) sent14 = true;
      }

      if (sent14) {
        const { error: stampError } = await supabase
          .from("contractors")
          .update({ coi_reminder_14_sent_at: now })
          .eq("id", contractorId);

        if (stampError) {
          result.errors.push(
            `Contractor ${contractorId}: 14-day stamp failed — ${stampError.message}`
          );
        } else {
          result.reminded14++;
          console.log(
            `[${FUNCTION_NAME}] Contractor ${contractorId}: 14-day reminder sent.`
          );
        }
      } else {
        result.errors.push(
          `Contractor ${contractorId}: 14-day email failed to send.`
        );
      }
    }

    // 30-day reminder (≤30 days until expiry)
    if (days <= 30 && !contractor.coi_reminder_30_sent_at) {
      const email30 = build30DayEmail({
        contractorName: name,
        expiryDateDisplay,
        mailgunDomain,
      });

      let sent30 = false;
      for (const recipient of recipients) {
        const ok = await sendMailgunEmail(
          mailgunApiKey,
          mailgunDomain,
          recipient,
          fromAddress,
          email30.subject,
          email30.text,
          email30.html
        );
        if (ok) sent30 = true;
      }

      if (sent30) {
        const { error: stampError } = await supabase
          .from("contractors")
          .update({ coi_reminder_30_sent_at: now })
          .eq("id", contractorId);

        if (stampError) {
          result.errors.push(
            `Contractor ${contractorId}: 30-day stamp failed — ${stampError.message}`
          );
        } else {
          result.reminded30++;
          console.log(
            `[${FUNCTION_NAME}] Contractor ${contractorId}: 30-day reminder sent.`
          );
        }
      } else {
        result.errors.push(
          `Contractor ${contractorId}: 30-day email failed to send.`
        );
      }
    }
  }

  return result;
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  // ── Environment ──────────────────────────────────────────────────────────
  const supabaseUrl   = Deno.env.get("SUPABASE_URL")!;
  const serviceKey    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY")!;
  const mailgunDomain = Deno.env.get("MAILGUN_DOMAIN")!;

  if (!supabaseUrl || !serviceKey || !mailgunApiKey || !mailgunDomain) {
    console.error(`[${FUNCTION_NAME}] Missing required env vars.`);
    return jsonResponse({ error: "Server configuration error" }, 500, corsHeaders);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // ── Rate limit guard (function-level; p_caller_id = null = global) ──────
  // check_rate_limit() signature: p_function_name TEXT, p_caller_id UUID DEFAULT NULL
  // Cron functions have no user UUID — pass null to use the global limit.
  const { data: rateLimitOk, error: rlError } = await supabase.rpc(
    "check_rate_limit",
    { p_function_name: FUNCTION_NAME, p_caller_id: null }
  );

  if (rlError) {
    console.error(`[${FUNCTION_NAME}] Rate limit RPC error:`, rlError.message);
    return jsonResponse(
      { error: "Rate limit check failed", detail: rlError.message },
      503,
      corsHeaders
    );
  }

  if (!rateLimitOk) {
    console.warn(`[${FUNCTION_NAME}] Rate limit exceeded — skipping run.`);
    return jsonResponse(
      { error: "Rate limit exceeded", skipped: true },
      429,
      corsHeaders
    );
  }

  // ── Optional single-contractor scope (for testing) ───────────────────────
  let scopeContractorId: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.contractor_id && typeof body.contractor_id === "string") {
      scopeContractorId = body.contractor_id;
      console.log(
        `[${FUNCTION_NAME}] Scoped to contractor: ${scopeContractorId}`
      );
    }
  } catch {
    // No body — run globally
  }

  const startedAt = Date.now();
  const result = await processCOIReminders(
    supabase,
    mailgunApiKey,
    mailgunDomain,
    scopeContractorId
  );
  result.elapsedMs = Date.now() - startedAt;
  result.ranAt = new Date().toISOString();

  console.log(`[${FUNCTION_NAME}] Run complete:`, JSON.stringify(result));

  return jsonResponse(result, 200, corsHeaders);
});
