/**
 * OtterQuote Edge Function: counter-sig-reminders
 *
 * D-149 — Counter-Signature Nudge Cadence (ClickUp 86e1gabf4)
 *
 * Invoked every 30 minutes via pg_cron (sql/v92, schedule "each half hour").
 * May also be manually POST-ed for testing.
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 *
 * When a homeowner signs a contract, docusign-webhook sends the contractor an
 * immediate counter-signature nudge and inserts a marker row into the
 * `notifications` table:
 *
 *   notification_type = 'countersign_nudge_pending'
 *   message_preview   = 'envelope=<envelopeId>;homeowner_signed_at=<ISO ts>'
 *
 * This function drains those markers: for every envelope still awaiting the
 * contractor's counter-signature, it sends a Mailgun reminder every 2 hours
 * during business hours (8am–6pm contractor local time) until counter-signed.
 *
 * ── Why `notifications` and not activity_log / a new column ─────────────────
 *   No schema change was permitted for this build (D-149 is an implementation
 *   gap, not a migration). activity_log cannot be used: its live schema has
 *   NOT NULL user_id + title and an event_type CHECK constraint, which reject
 *   webhook-context inserts (86e1tz17j audit-write class). The notifications
 *   table (nullable user_id/claim_id, free-text notification_type) is already
 *   written by docusign-webhook successfully in production.
 *
 * ── Reminder-window mechanism (no schema change) ─────────────────────────────
 *   Deterministic 2-hour bucket gate. With elapsed = minutes since
 *   homeowner_signed_at, a reminder is DUE on a given 30-minute cron tick iff:
 *
 *     elapsed >= 120  AND  (elapsed % 120) < 30
 *
 *   Exactly one tick falls inside the first 30-minute sub-window of each
 *   2-hour bucket, so at most one reminder per contract per 2-hour window —
 *   stateless. The first window (0–2h) is skipped because docusign-webhook
 *   already sent the immediate nudge at T0.
 *
 *   Belt-and-braces: each send is stamped as a notifications row
 *   (notification_type 'countersign_reminder_sent',
 *   message_preview 'envelope=<id>;bucket=<n>;...') and a bucket that already
 *   has a stamp is never re-sent — protects against cron misconfiguration
 *   (e.g., accidentally scheduled more often than every 30 min).
 *
 *   If the due tick for a bucket lands OUTSIDE business hours, that window's
 *   reminder is skipped (not deferred); the next reminder lands on the next
 *   2-hour boundary that falls inside business hours. Overnight signings get
 *   their first scheduled reminder on the first in-hours 2-hour boundary.
 *
 * ── Timezone ─────────────────────────────────────────────────────────────────
 *   Uses contractors.timezone (added in sql/v32, TEXT, column default
 *   'America/New_York'). When the value is NULL or not a valid IANA zone,
 *   falls back to 'America/New_York' — the same default the column itself
 *   carries. No schema change.
 *
 * ── Termination / no duplicates ──────────────────────────────────────────────
 *   - quotes.contractor_signed_at IS NOT NULL  → skip (counter-signed).
 *   - claims.contract_signed_at set            → skip (fully executed).
 *   - claims.contract_declined_at / contract_voided_at set → skip (dead).
 *   - Markers older than 30 days are ignored (safety stop so a dead deal is
 *     not nudged forever; flagged in the D-149 work log as a judgment call).
 *
 * ── Auth ─────────────────────────────────────────────────────────────────────
 *   Invoked by pg_cron with the service-role bearer token (same v50a pattern
 *   as process-coi-reminders). verify_jwt is pinned true in config.toml — the
 *   service-role key is a valid JWT, so the platform gate stays on.
 *
 * ── Env vars required ────────────────────────────────────────────────────────
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN
 *
 * ── Returns ──────────────────────────────────────────────────────────────────
 *   {
 *     candidates: N,          // pending markers examined (post 30-day filter)
 *     sent: N,                // reminders sent this run
 *     skippedNotDue: N,       // outside the 2-hour bucket gate this tick
 *     skippedCounterSigned: N,// contractor already counter-signed
 *     skippedClosed: N,       // claim executed / declined / voided
 *     skippedOutsideHours: N, // due, but outside 8am–6pm contractor local
 *     skippedAlreadySent: N,  // bucket already stamped (belt-and-braces)
 *     skippedNoData: N,       // missing quote / contractor / email
 *     errors: [...],          // non-fatal per-contract errors
 *     elapsedMs: N,
 *     ranAt: "..."
 *   }
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// =============================================================================
// CONSTANTS
// =============================================================================

const FUNCTION_NAME = "counter-sig-reminders";

// CORS allowlist — cron doesn't use CORS, but defense-in-depth for any
// browser-side calls (e.g., Dustin manually triggering from devtools).
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

const CONTRACTOR_DASHBOARD_URL =
  "https://otterquote.com/contractor-dashboard.html";

// contractors.timezone column default (sql/v32). Used when the row value is
// NULL or not a valid IANA timezone.
const DEFAULT_TIMEZONE = "America/New_York";

const BUSINESS_HOURS_START = 8; // inclusive, contractor local time
const BUSINESS_HOURS_END = 18;  // exclusive, contractor local time

const REMINDER_INTERVAL_MIN = 120; // one reminder per 2-hour bucket
const CRON_TICK_MIN = 30;          // pg_cron invokes every 30 minutes

// Safety stop: markers older than this are ignored so a dead deal is not
// nudged forever. Judgment call flagged in the D-149 work log — D-149 itself
// says "until counter-signed" with no upper bound.
const MARKER_MAX_AGE_DAYS = 30;

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
// MAILGUN HELPER (same shape as process-coi-reminders)
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
// TIME HELPERS
// =============================================================================

/**
 * Current hour (0-23) in the given IANA timezone. Falls back to
 * DEFAULT_TIMEZONE when the zone string is invalid.
 */
function localHour(timezone: string): number {
  const read = (tz: string): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const hourPart = parts.find((p) => p.type === "hour");
    return Number(hourPart?.value ?? NaN);
  };
  try {
    const h = read(timezone);
    if (Number.isFinite(h)) return h;
  } catch {
    // invalid timezone string — fall through to default
  }
  return read(DEFAULT_TIMEZONE);
}

/**
 * Parses a countersign_nudge_pending marker's message_preview:
 *   'envelope=<envelopeId>;homeowner_signed_at=<ISO ts>'
 * Returns null if the format does not match.
 */
function parseMarker(
  preview: string | null
): { envelopeId: string; homeownerSignedAt: string } | null {
  if (!preview) return null;
  const match = preview.match(/^envelope=([^;]+);homeowner_signed_at=(.+)$/);
  if (!match) return null;
  return { envelopeId: match[1], homeownerSignedAt: match[2] };
}

// =============================================================================
// EMAIL BUILDER — branded wrapper matches process-coi-reminders
// =============================================================================

/**
 * Shared branded HTML wrapper. Navy (#0D1B2E) header, amber (#E07B00) accent.
 */
function wrapEmail(params: {
  heading: string;
  bodyHtml: string;
  ctaText: string;
  ctaUrl: string;
}): string {
  const { heading, bodyHtml, ctaText, ctaUrl } = params;

  const ctaBlock = `<p style="text-align:center;margin:28px 0 0;">
         <a href="${ctaUrl}"
            style="display:inline-block;background:#E07B00;color:#fff;padding:13px 28px;
                   border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;
                   letter-spacing:0.01em;">
           ${ctaText}
         </a>
       </p>`;

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
              <h2 style="margin:0 0 18px;color:#0D1B2E;font-size:20px;
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

function buildReminderEmail(params: {
  contractorName: string;
  propertyAddress: string;
  jobNumber: string;
  hoursSinceSigned: number;
}): { subject: string; text: string; html: string } {
  const { contractorName, propertyAddress, jobNumber, hoursSinceSigned } = params;

  const subject = "Reminder: contract awaiting your counter-signature";

  const text = `Hi ${contractorName},

The homeowner signed the contract for ${propertyAddress} (${jobNumber}) about ${hoursSinceSigned} hours ago, and it is still awaiting your counter-signature.

Once you sign, the agreement is fully executed and the project can move forward.

Counter-sign from your dashboard:
${CONTRACTOR_DASHBOARD_URL}

You will continue to receive these reminders every 2 hours during business hours until the contract is fully executed.

Questions? Reply to this email or call (844) 875-3412.

— The Otter Quotes Team`;

  const bodyHtml = `
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Hi ${contractorName},
    </p>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      The homeowner signed the contract for <strong>${propertyAddress}</strong>
      (${jobNumber}) about <strong>${hoursSinceSigned} hours ago</strong>, and it is
      still awaiting your counter-signature.
    </p>
    <p style="margin:0 0 14px;color:#3D4F60;font-size:15px;line-height:1.6;">
      Once you sign, the agreement is fully executed and the project can move forward.
    </p>
    <p style="margin:0;color:#3D4F60;font-size:13px;line-height:1.6;">
      You will continue to receive these reminders every 2 hours during business
      hours until the contract is fully executed.
    </p>`;

  const html = wrapEmail({
    heading: "Contract awaiting your counter-signature",
    bodyHtml,
    ctaText: "Counter-Sign Now",
    ctaUrl: CONTRACTOR_DASHBOARD_URL,
  });

  return { subject, text, html };
}

// =============================================================================
// MAIN PROCESSING LOGIC
// =============================================================================

interface ProcessResult {
  candidates: number;
  sent: number;
  skippedNotDue: number;
  skippedCounterSigned: number;
  skippedClosed: number;
  skippedOutsideHours: number;
  skippedAlreadySent: number;
  skippedNoData: number;
  errors: string[];
  elapsedMs: number;
  ranAt: string;
}

async function processReminders(
  supabase: ReturnType<typeof createClient>,
  mailgunApiKey: string,
  mailgunDomain: string
): Promise<Omit<ProcessResult, "elapsedMs" | "ranAt">> {
  const result = {
    candidates: 0,
    sent: 0,
    skippedNotDue: 0,
    skippedCounterSigned: 0,
    skippedClosed: 0,
    skippedOutsideHours: 0,
    skippedAlreadySent: 0,
    skippedNoData: 0,
    errors: [] as string[],
  };

  const nowMs = Date.now();
  const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;
  const markerCutoff = new Date(
    nowMs - MARKER_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  // Pending markers written by docusign-webhook at the homeowner-signed
  // transition (see file header for format).
  const { data: markers, error: fetchError } = await supabase
    .from("notifications")
    .select("id, claim_id, message_preview, created_at")
    .eq("notification_type", "countersign_nudge_pending")
    .gte("created_at", markerCutoff);

  if (fetchError) {
    console.error(`[${FUNCTION_NAME}] marker fetch error:`, fetchError.message);
    result.errors.push(`Marker fetch failed: ${fetchError.message}`);
    return result;
  }

  if (!markers || markers.length === 0) {
    console.log(`[${FUNCTION_NAME}] No pending counter-signature markers.`);
    return result;
  }

  // De-duplicate by envelope (keep the earliest marker per envelope; the
  // webhook's own idempotency guard should make duplicates rare).
  const byEnvelope = new Map<
    string,
    { claimId: string | null; homeownerSignedAt: string; createdAt: string }
  >();
  for (const marker of markers) {
    const parsed = parseMarker(marker.message_preview as string | null);
    if (!parsed) {
      result.errors.push(`Unparsable marker ${marker.id} — skipped.`);
      continue;
    }
    // Prefer the parsed homeowner_signed_at; fall back to the marker row's
    // created_at (webhook processes Connect events within seconds of signing).
    const signedAt = Number.isFinite(Date.parse(parsed.homeownerSignedAt))
      ? parsed.homeownerSignedAt
      : (marker.created_at as string);
    const existing = byEnvelope.get(parsed.envelopeId);
    if (!existing || signedAt < existing.homeownerSignedAt) {
      byEnvelope.set(parsed.envelopeId, {
        claimId: (marker.claim_id as string | null) ?? null,
        homeownerSignedAt: signedAt,
        createdAt: marker.created_at as string,
      });
    }
  }

  result.candidates = byEnvelope.size;
  console.log(
    `[${FUNCTION_NAME}] Examining ${byEnvelope.size} envelope(s) awaiting counter-signature.`
  );

  for (const [envelopeId, marker] of byEnvelope) {
    try {
      // ── 2-hour bucket gate (cheapest check first) ──────────────────────────
      const signedAtMs = Date.parse(marker.homeownerSignedAt);
      const elapsedMin = (nowMs - signedAtMs) / 60000;
      const due =
        elapsedMin >= REMINDER_INTERVAL_MIN &&
        elapsedMin % REMINDER_INTERVAL_MIN < CRON_TICK_MIN;
      if (!due) {
        result.skippedNotDue++;
        continue;
      }
      const bucket = Math.floor(elapsedMin / REMINDER_INTERVAL_MIN);

      // ── Still awaiting counter-signature? (the no-duplicate WHERE clause) ──
      const { data: quote, error: quoteErr } = await supabase
        .from("quotes")
        .select("id, claim_id, contractor_id, contractor_signed_at")
        .eq("docusign_envelope_id", envelopeId)
        .maybeSingle();
      if (quoteErr) {
        result.errors.push(`Envelope ${envelopeId}: quote fetch failed — ${quoteErr.message}`);
        continue;
      }
      if (!quote) {
        result.skippedNoData++;
        continue;
      }
      if (quote.contractor_signed_at) {
        result.skippedCounterSigned++;
        continue;
      }

      // ── Claim still open? ──────────────────────────────────────────────────
      const { data: claimRow, error: claimErr } = await supabase
        .from("claims")
        .select("id, property_address, contract_signed_at, contract_declined_at, contract_voided_at")
        .eq("id", quote.claim_id)
        .single();
      if (claimErr || !claimRow) {
        result.errors.push(
          `Envelope ${envelopeId}: claim fetch failed — ${claimErr?.message || "not found"}`
        );
        continue;
      }
      if (
        claimRow.contract_signed_at ||
        claimRow.contract_declined_at ||
        claimRow.contract_voided_at
      ) {
        result.skippedClosed++;
        continue;
      }

      // ── Contractor + business-hours gate ───────────────────────────────────
      const { data: contractor, error: contractorErr } = await supabase
        .from("contractors")
        .select("id, contact_name, company_name, email, notification_emails, timezone")
        .eq("id", quote.contractor_id)
        .single();
      if (contractorErr || !contractor) {
        result.errors.push(
          `Envelope ${envelopeId}: contractor fetch failed — ${contractorErr?.message || "not found"}`
        );
        continue;
      }

      const hour = localHour((contractor.timezone as string) || DEFAULT_TIMEZONE);
      if (hour < BUSINESS_HOURS_START || hour >= BUSINESS_HOURS_END) {
        result.skippedOutsideHours++;
        continue;
      }

      const recipients: string[] = [];
      if (contractor.email) recipients.push(contractor.email as string);
      if (Array.isArray(contractor.notification_emails)) {
        for (const e of contractor.notification_emails) {
          if (e && !recipients.includes(e)) recipients.push(e);
        }
      }
      if (recipients.length === 0) {
        console.warn(`[${FUNCTION_NAME}] Contractor ${contractor.id} has no email — skipped.`);
        result.skippedNoData++;
        continue;
      }

      // ── Bucket already stamped? (belt-and-braces dedupe) ───────────────────
      const { data: stamp } = await supabase
        .from("notifications")
        .select("id")
        .eq("notification_type", "countersign_reminder_sent")
        .like("message_preview", `envelope=${envelopeId};bucket=${bucket};%`)
        .limit(1)
        .maybeSingle();
      if (stamp) {
        result.skippedAlreadySent++;
        continue;
      }

      // ── Send ───────────────────────────────────────────────────────────────
      const email = buildReminderEmail({
        contractorName: (contractor.contact_name as string) || "Contractor",
        propertyAddress: (claimRow.property_address as string) || "your project",
        jobNumber: `Job #${(claimRow.id as string).slice(-8).toUpperCase()}`,
        hoursSinceSigned: Math.round(elapsedMin / 60),
      });

      let anySent = false;
      for (const recipient of recipients) {
        const ok = await sendMailgunEmail(
          mailgunApiKey,
          mailgunDomain,
          recipient,
          fromAddress,
          email.subject,
          email.text,
          email.html
        );
        if (ok) anySent = true;
      }

      if (!anySent) {
        result.errors.push(`Envelope ${envelopeId}: reminder email failed to send.`);
        continue;
      }

      // Stamp the bucket so it is never re-sent.
      const { error: stampErr } = await supabase.from("notifications").insert({
        claim_id: quote.claim_id,
        channel: "email",
        notification_type: "countersign_reminder_sent",
        recipient: recipients[0],
        message_preview: `envelope=${envelopeId};bucket=${bucket};sent_at=${new Date().toISOString()}`,
      });
      if (stampErr) {
        // The deterministic tick gate still prevents re-sends within this
        // bucket (next tick fails the % check), so log-and-continue is safe.
        result.errors.push(
          `Envelope ${envelopeId}: bucket stamp failed — ${stampErr.message}`
        );
      }

      result.sent++;
      console.log(
        `[${FUNCTION_NAME}] Reminder sent: envelope=${envelopeId} bucket=${bucket} contractor=${contractor.id}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Envelope ${envelopeId}: ${msg}`);
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

  const startedAt = Date.now();

  const processResult = await processReminders(
    supabase,
    mailgunApiKey,
    mailgunDomain
  );

  const result: ProcessResult = {
    ...processResult,
    elapsedMs: Date.now() - startedAt,
    ranAt: new Date().toISOString(),
  };

  console.log(`[${FUNCTION_NAME}] Run complete:`, JSON.stringify(result));

  // ── Write cron_health so platform-health-check staleness monitor sees this
  // run (same self-reporting contract as process-coi-reminders; bug class
  // 86e194gtz). ──
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
