/**
 * OtterQuote Edge Function: process-coi-reminders
 *
 * D-170 — Nightly COI Expiry Reminder System
 * D-210 — Extended with Workers' Comp Certificate Expiry Reminders
 *
 * Invoked daily at 8:00 AM via pg_cron (schedule: "0 8 * * *").
 * May also be manually POST-ed with an optional { "contractor_id": "..." }
 * body to scope to a single contractor — useful for testing.
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 *
 * Part 1: COI Expiry Reminders (D-170, existing)
 * Queries all active contractors where coi_expires_at IS NOT NULL.
 * For each, calculates days until expiry and sends Mailgun reminder emails
 * at the 30, 14, and 7-day marks — exactly once per window, enforced by
 * the idempotency timestamp columns:
 *   - coi_reminder_30_sent_at   (set when 30-day reminder fires)
 *   - coi_reminder_14_sent_at   (set when 14-day reminder fires)
 *   - coi_reminder_7_sent_at    (set when 7-day reminder fires)
 *
 * On COI expiry (coi_expires_at <= CURRENT_DATE):
 *   - Sends "COI has expired — bidding suspended" notice.
 *   - Sets coi_expired_notified_at = NOW() (send-once guard).
 *   - Sets contractors.status = 'suspended'.
 *
 * Part 2: Workers' Comp Certificate Expiry Reminders (D-210, new)
 * Queries all contractors where:
 *   - wc_cert_expiry IS NOT NULL
 *   - wc_cert_file_ref != 'WCE-1-EXEMPT' (not exempted via WCE-1)
 * Sends 30-day reminder using same cadence and idempotency pattern:
 *   - wc_cert_reminder_30_sent_at (set when 30-day reminder fires)
 *
 * ── COI requirements included in all COI email copy ───────────────────────────
 *   - $1,000,000 per occurrence / $2,000,000 aggregate (CGL)
 *   - Products-Completed Operations and Contractual Liability coverage
 *   - Stellar Edge Services LLC named as Additional Insured,
 *     primary and non-contributory
 *
 * ── WC Certificate requirements included in WC email copy ────────────────────
 *   - Active, continuous coverage
 *   - Covers all employees on roofing projects
 *   - Stellar Edge Services LLC named as Certificate Holder
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 *   Each reminder column is a one-way latch: once set, it is never cleared.
 *   Exception: if admin needs to re-send manually, they can null out the columns.
 *
 * ── Rate limiting ────────────────────────────────────────────────────────────
 *   Uses check_rate_limit() RPC against rate_limit_config.
 *   Caller ID: 'cron' (function-level guard — not per-contractor).
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
 *     coi: {
 *       reminded30: N,   // 30-day reminders sent this run
 *       reminded14: N,   // 14-day reminders sent this run
 *       reminded7: N,    // 7-day reminders sent this run
 *       expired: N,      // expired notices sent + status set to suspended
 *       skipped: N,      // contractors with no email / invalid data
 *       errors: [...]    // non-fatal per-contractor errors
 *     },
 *     wc: {
 *       reminded30: N,   // 30-day WC cert reminders sent
 *       skipped: N,      // contractors with no email / invalid data
 *       errors: [...]    // non-fatal per-contractor errors
 *     },
 *     elapsedMs: N,
 *     ranAt: "..."
 *   }
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  build30DayEmail,
  build14DayEmail,
  build7DayEmail,
  buildExpiredEmail,
  buildWC30DayEmail,
} from "./templates.ts"; // gh-1824: email bodies moved to templates.ts (testable, no serve() import)

// =============================================================================
// CONSTANTS
// =============================================================================

const FUNCTION_NAME = "process-coi-reminders";

// CORS allowlist — cron doesn't use CORS, but defense-in-depth for any
// browser-side calls (e.g., Dustin manually triggering from devtools).
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

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
function daysUntilExpiry(expiryDate: string): number {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const expiry = new Date(expiryDate + "T00:00:00Z");
  return Math.round((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

// =============================================================================
// MAIN PROCESSING LOGIC
// =============================================================================

interface COIResult {
  reminded30: number;
  reminded14: number;
  reminded7: number;
  expired: number;
  skipped: number;
  errors: string[];
}

interface WCResult {
  reminded30: number;
  skipped: number;
  errors: string[];
}

interface ProcessResult {
  coi: COIResult;
  wc: WCResult;
  elapsedMs: number;
  ranAt: string;
}

async function processCOIReminders(
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  scopeContractorId?: string
): Promise<COIResult> {
  const result: COIResult = {
    reminded30: 0,
    reminded14: 0,
    reminded7: 0,
    expired: 0,
    skipped: 0,
    errors: [],
  };

  const now = new Date().toISOString();
  const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;

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
    console.error(`[${FUNCTION_NAME}] COI fetch error:`, fetchError.message);
    result.errors.push(`COI fetch failed: ${fetchError.message}`);
    return result;
  }

  if (!contractors || contractors.length === 0) {
    console.log(`[${FUNCTION_NAME}] No active contractors with COI dates found.`);
    return result;
  }

  console.log(
    `[${FUNCTION_NAME}] Processing ${contractors.length} contractor(s) for COI reminders.`
  );

  for (const contractor of contractors) {
    const contractorId = contractor.id;
    const name = contractor.contact_name || "Contractor";
    const coiDate = contractor.coi_expires_at as string;

    const recipients: string[] = [];
    if (contractor.email) recipients.push(contractor.email);
    if (Array.isArray(contractor.notification_emails)) {
      for (const e of contractor.notification_emails) {
        if (e && !recipients.includes(e)) recipients.push(e);
      }
    }

    if (recipients.length === 0) {
      console.warn(
        `[${FUNCTION_NAME}] Contractor ${contractorId} has no email — COI skipped.`
      );
      result.skipped++;
      continue;
    }

    const days = daysUntilExpiry(coiDate);
    const expiryDateDisplay = new Date(coiDate + "T00:00:00Z").toLocaleDateString(
      "en-US",
      { month: "long", day: "numeric", year: "numeric" }
    );

    console.log(
      `[${FUNCTION_NAME}] Contractor ${contractorId} (${name}): ` +
        `COI expires ${coiDate} (${days} days)`
    );

    // EXPIRED PATH
    if (days <= 0) {
      if (contractor.coi_expired_notified_at) {
        console.log(
          `[${FUNCTION_NAME}] Contractor ${contractorId}: COI expired notice already sent.`
        );
        continue;
      }

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
          `Contractor ${contractorId}: COI expired email failed to send (account suspended; status updated)`
        );
      }

      result.expired++;
      console.log(
        `[${FUNCTION_NAME}] Contractor ${contractorId}: COI expired — suspended + notified.`
      );
      continue;
    }

    // UPCOMING REMINDERS
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
          console.log(`[${FUNCTION_NAME}] Contractor ${contractorId}: 7-day COI reminder sent.`);
        }
      } else {
        result.errors.push(`Contractor ${contractorId}: 7-day COI email failed to send.`);
      }
    }

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
          console.log(`[${FUNCTION_NAME}] Contractor ${contractorId}: 14-day COI reminder sent.`);
        }
      } else {
        result.errors.push(`Contractor ${contractorId}: 14-day COI email failed to send.`);
      }
    }

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
          console.log(`[${FUNCTION_NAME}] Contractor ${contractorId}: 30-day COI reminder sent.`);
        }
      } else {
        result.errors.push(`Contractor ${contractorId}: 30-day COI email failed to send.`);
      }
    }
  }

  return result;
}

async function processWCReminders(
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string,
  scopeContractorId?: string
): Promise<WCResult> {
  const result: WCResult = {
    reminded30: 0,
    skipped: 0,
    errors: [],
  };

  const now = new Date().toISOString();
  const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;

  let query = supabase
    .from("contractors")
    .select(
      `id, user_id, contact_name, email, notification_emails,
       wc_cert_expiry, wc_cert_file_ref,
       wc_cert_reminder_30_sent_at, is_test`
    )
    .not("wc_cert_expiry", "is", null);

  if (scopeContractorId) {
    query = query.eq("id", scopeContractorId);
  }

  const { data: contractors, error: fetchError } = await query;

  if (fetchError) {
    console.error(`[${FUNCTION_NAME}] WC fetch error:`, fetchError.message);
    result.errors.push(`WC fetch failed: ${fetchError.message}`);
    return result;
  }

  if (!contractors || contractors.length === 0) {
    console.log(`[${FUNCTION_NAME}] No contractors with WC cert dates found.`);
    return result;
  }

  console.log(
    `[${FUNCTION_NAME}] Processing ${contractors.length} contractor(s) for WC reminders.`
  );

  for (const contractor of contractors) {
    const contractorId = contractor.id;
    const name = contractor.contact_name || "Contractor";
    const wcExpiryDate = contractor.wc_cert_expiry as string;
    const wcCertFileRef = contractor.wc_cert_file_ref as string | null;

    // Skip if exempted via WCE-1
    if (wcCertFileRef === "WCE-1-EXEMPT") {
      console.log(
        `[${FUNCTION_NAME}] Contractor ${contractorId}: WCE-1 exempt — skipping WC reminder.`
      );
      result.skipped++;
      continue;
    }

    const recipients: string[] = [];
    if (contractor.email) recipients.push(contractor.email);
    if (Array.isArray(contractor.notification_emails)) {
      for (const e of contractor.notification_emails) {
        if (e && !recipients.includes(e)) recipients.push(e);
      }
    }

    if (recipients.length === 0) {
      console.warn(
        `[${FUNCTION_NAME}] Contractor ${contractorId} has no email — WC skipped.`
      );
      result.skipped++;
      continue;
    }

    const days = daysUntilExpiry(wcExpiryDate);
    const expiryDateDisplay = new Date(wcExpiryDate + "T00:00:00Z").toLocaleDateString(
      "en-US",
      { month: "long", day: "numeric", year: "numeric" }
    );

    console.log(
      `[${FUNCTION_NAME}] Contractor ${contractorId} (${name}): ` +
        `WC cert expires ${wcExpiryDate} (${days} days)`
    );

    // 30-day WC reminder
    if (days <= 30 && !contractor.wc_cert_reminder_30_sent_at) {
      const emailWC = buildWC30DayEmail({
        contractorName: name,
        expiryDateDisplay,
        mailgunDomain,
      });

      let sentWC = false;
      for (const recipient of recipients) {
        const ok = await sendMailgunEmail(
          mailgunApiKey,
          mailgunDomain,
          recipient,
          fromAddress,
          emailWC.subject,
          emailWC.text,
          emailWC.html
        );
        if (ok) sentWC = true;
      }

      if (sentWC) {
        const { error: stampError } = await supabase
          .from("contractors")
          .update({ wc_cert_reminder_30_sent_at: now })
          .eq("id", contractorId);

        if (stampError) {
          result.errors.push(
            `Contractor ${contractorId}: WC 30-day stamp failed — ${stampError.message}`
          );
        } else {
          result.reminded30++;
          console.log(`[${FUNCTION_NAME}] Contractor ${contractorId}: 30-day WC reminder sent.`);
          
          // Log to activity_log
          const { error: logError } = await supabase.from("activity_log").insert({
            event_type: "wc_cert_expiry_reminder_sent",
            title: "wc_cert_expiry_reminder_sent",
            user_id: contractor.user_id,
            is_test: contractor.is_test ?? false,
            metadata: { contractor_id: contractorId, days_until_expiry: days, expiry_date: wcExpiryDate },
          });
          
          if (logError) {
            console.warn(
              `[${FUNCTION_NAME}] Failed to log WC reminder for ${contractorId}: ${logError.message}`
            );
          }
        }
      } else {
        result.errors.push(`Contractor ${contractorId}: WC 30-day email failed to send.`);
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

  const supabaseUrl   = Deno.env.get("SUPABASE_URL")!;
  const serviceKey    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY")!;
  const mailgunDomain = Deno.env.get("MAILGUN_DOMAIN")!;

  if (!supabaseUrl || !serviceKey || !mailgunApiKey || !mailgunDomain) {
    console.error(`[${FUNCTION_NAME}] Missing required env vars.`);
    return jsonResponse({ error: "Server configuration error" }, 500, corsHeaders);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: rateLimitOk, error: rlError } = await supabase.rpc(
    "check_rate_limit",
    { p_function_name: FUNCTION_NAME, p_user_id: null }
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
    // No body
  }

  const startedAt = Date.now();
  
  const coiResult = await processCOIReminders(
    supabase,
    mailgunApiKey,
    mailgunDomain,
    scopeContractorId
  );

  const wcResult = await processWCReminders(
    supabase,
    mailgunApiKey,
    mailgunDomain,
    scopeContractorId
  );

  const result: ProcessResult = {
    coi: coiResult,
    wc: wcResult,
    elapsedMs: Date.now() - startedAt,
    ranAt: new Date().toISOString(),
  };

  console.log(`[${FUNCTION_NAME}] Run complete:`, JSON.stringify(result));

  // ── Write cron_health so platform-health-check staleness monitor sees this run ──
  // IMPORTANT: process-coi-reminders is a "self-reporting" cron job — it must call
  // record_cron_health on every successful exit. Removing this call causes false
  // stale-cron alerts within 25 hours (bug class: 86e194gtz, 2026-05-07).
  try {
    await supabase.rpc("record_cron_health", {
      p_job_name: FUNCTION_NAME,
      p_status:   "success",
      p_error:    null,
    });
    console.log(`[${FUNCTION_NAME}] cron_health updated.`);
  } catch (healthErr) {
    console.warn(`[${FUNCTION_NAME}] record_cron_health write failed (non-fatal):`, healthErr);
  }

  return jsonResponse(result, 200, corsHeaders);
});
