/**
 * OtterQuote Edge Function: process-dunning v2.0
 * Handles the dunning sequence for failed contractor payments.
 *
 * ── OVERHAULED April 14, 2026 ──
 * New notification cadence:
 *   - Frequency: every 1 hour (was 2)
 *   - Quiet hours: 9 PM – 6 AM in the CONTRACTOR'S local timezone (was 9 PM – 7 AM ET)
 *   - Recipients: ALL emails + ALL phones on file (was primary email only)
 *   - Hourly message: fixed text linking to contractor-settings.html
 *   - 8 AM next-business-day (Mon–Fri) warning: new escalation text
 *   - 10 AM next-business-day homeowner notification: two CTAs
 *   - Late rule: if payment fails after 8 AM contractor local time, entire
 *     sequence defers to next business day
 *   - No messages between the 8 AM warning and the 10 AM homeowner notification
 *
 * Modes:
 *   TRIGGER   POST body { quote_id, contractor_id, claim_id, homeowner_id, amount_cents, stripe_error }
 *   CRON      POST/GET without body — scans all active dunning records
 *   HOMEOWNER GET ?mode=homeowner_choice&failure_id=UUID&choice=proceed|different
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *   TWILIO_MESSAGING_SERVICE_SID (preferred) or TWILIO_PHONE_NUMBER (fallback)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PLATFORM_URL = "https://otterquote.com";
const SETTINGS_URL = `${PLATFORM_URL}/contractor-settings.html`;
const ADMIN_EMAIL  = "dustinstohler1@gmail.com";
const STRIPE_API_BASE = "https://api.stripe.com/v1";

// CORS tightened (Session 254): origin-allowlisted instead of wildcard.
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

// ═══════════════════════════════════════════════════════════
// ── TIMEZONE UTILITIES ──
// ═══════════════════════════════════════════════════════════

/** State abbreviation → IANA timezone (most-common/majority zone per state). */
const STATE_TIMEZONE: Record<string, string> = {
  AL: "America/Chicago",        AK: "America/Anchorage",
  AZ: "America/Phoenix",        AR: "America/Chicago",
  CA: "America/Los_Angeles",    CO: "America/Denver",
  CT: "America/New_York",       DE: "America/New_York",
  FL: "America/New_York",       GA: "America/New_York",
  HI: "Pacific/Honolulu",       ID: "America/Denver",
  IL: "America/Chicago",        IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago",        KS: "America/Chicago",
  KY: "America/New_York",       LA: "America/Chicago",
  ME: "America/New_York",       MD: "America/New_York",
  MA: "America/New_York",       MI: "America/New_York",
  MN: "America/Chicago",        MS: "America/Chicago",
  MO: "America/Chicago",        MT: "America/Denver",
  NE: "America/Chicago",        NV: "America/Los_Angeles",
  NH: "America/New_York",       NJ: "America/New_York",
  NM: "America/Denver",         NY: "America/New_York",
  NC: "America/New_York",       ND: "America/Chicago",
  OH: "America/New_York",       OK: "America/Chicago",
  OR: "America/Los_Angeles",    PA: "America/New_York",
  RI: "America/New_York",       SC: "America/New_York",
  SD: "America/Chicago",        TN: "America/Chicago",
  TX: "America/Chicago",        UT: "America/Denver",
  VT: "America/New_York",       VA: "America/New_York",
  WA: "America/Los_Angeles",    WV: "America/New_York",
  WI: "America/Chicago",        WY: "America/Denver",
  DC: "America/New_York",
};

/** Resolve contractor timezone: explicit field → state derivation → ET fallback. */
function resolveTimezone(tzField: string | null, state: string | null): string {
  if (tzField && tzField !== "America/New_York") return tzField;
  if (state) {
    const derived = STATE_TIMEZONE[state.toUpperCase().trim()];
    if (derived) return derived;
  }
  return tzField || "America/New_York";
}

/** Parse a UTC date into its local date/time components for the given timezone. */
function localParts(date: Date, tz: string): {
  year: number; month: number; day: number;
  hour: number; minute: number; weekday: number; // 0=Sun, 6=Sat
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const g = (type: string) => parts.find(p => p.type === type)?.value ?? "0";
  const h = parseInt(g("hour"));
  return {
    year:    parseInt(g("year")),
    month:   parseInt(g("month")),
    day:     parseInt(g("day")),
    hour:    h === 24 ? 0 : h, // some impls return 24 for midnight
    minute:  parseInt(g("minute")),
    weekday: ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[g("weekday")] ?? 1,
  };
}

/**
 * Convert a local date/time (Y/M/D H:M) in a named timezone to a UTC Date.
 * Uses initial-guess + offset-correction so it handles DST correctly for
 * typical business hours (6 AM, 8 AM, 10 AM).
 */
function localToUTC(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  // Step 1: treat the local time as UTC to get an approximate timestamp
  const t0 = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  // Step 2: find what local time that UTC represents
  const p = localParts(t0, tz);
  // Step 3: compute the error (approxLocal - desired) in minutes
  let errorMin = (p.hour * 60 + p.minute) - (hour * 60 + minute);
  if (errorMin > 12 * 60) errorMin -= 24 * 60;
  if (errorMin < -12 * 60) errorMin += 24 * 60;
  // Step 4: subtract the error from our initial guess
  return new Date(t0.getTime() - errorMin * 60_000);
}

/**
 * Returns true if the given UTC instant falls in quiet hours
 * (9 PM–6 AM) in the contractor's local timezone.
 */
function isQuiet(date: Date, tz: string): boolean {
  const { hour } = localParts(date, tz);
  return hour >= 21 || hour < 6;
}

/**
 * Advance a UTC date by N calendar days (uses +24h increments, close enough
 * for business-day math at non-midnight hours).
 */
function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * 24 * 60 * 60_000);
}

/**
 * Given a reference UTC date, find the UTC timestamp of the next weekday
 * (Mon–Fri) at the specified local hour:minute in the given timezone.
 *
 * "Next" means strictly tomorrow or later — never today.
 */
function nextWeekdayAt(fromUTC: Date, localHour: number, localMinute: number, tz: string): Date {
  let candidate = addDays(fromUTC, 1);
  for (let attempts = 0; attempts < 10; attempts++) {
    const { weekday, year, month, day } = localParts(candidate, tz);
    if (weekday >= 1 && weekday <= 5) { // Mon–Fri
      return localToUTC(year, month, day, localHour, localMinute, tz);
    }
    candidate = addDays(candidate, 1);
  }
  // Fallback (should never reach here)
  const { year, month, day } = localParts(candidate, tz);
  return localToUTC(year, month, day, localHour, localMinute, tz);
}

/**
 * Returns true if today (in the contractor's timezone) is a weekday AND
 * the current local hour is before 8 AM.
 */
function isBeforeEightAMOnWeekday(now: Date, tz: string): boolean {
  const { weekday, hour, minute } = localParts(now, tz);
  const isWeekday = weekday >= 1 && weekday <= 5;
  const beforeEight = hour < 8 || (hour === 8 && minute === 0); // exactly 8:00 is fine
  return isWeekday && beforeEight;
}

/**
 * Compute the full dunning schedule for a new payment failure.
 *
 * Returns:
 *   warningAt          — UTC timestamp of the 8 AM next-business-day warning
 *   homeownerNotifyAt  — UTC timestamp of the 10 AM homeowner notification
 *   nextReminderAt     — UTC timestamp of the FIRST hourly reminder (null = send immediately)
 *   sendImmediately    — true if the first reminder should be sent right now (trigger mode)
 */
function computeSchedule(now: Date, tz: string): {
  warningAt: Date;
  homeownerNotifyAt: Date;
  nextReminderAt: Date;
  sendImmediately: boolean;
} {
  // Determine whether the entire sequence runs today or defers to next business day.
  const runToday = isBeforeEightAMOnWeekday(now, tz);

  let warningAt: Date;
  let homeownerNotifyAt: Date;

  if (runToday) {
    // 8 AM and 10 AM today in contractor's timezone
    const { year, month, day } = localParts(now, tz);
    warningAt         = localToUTC(year, month, day, 8,  0, tz);
    homeownerNotifyAt = localToUTC(year, month, day, 10, 0, tz);
  } else {
    // Payment failed after 8 AM, or on a weekend → defer to next business day
    warningAt         = nextWeekdayAt(now, 8,  0, tz);
    homeownerNotifyAt = nextWeekdayAt(now, 10, 0, tz);
  }

  // First reminder timing
  let nextReminderAt: Date;
  let sendImmediately: boolean;

  if (runToday && !isQuiet(now, tz)) {
    // Not in quiet hours, not after 8 AM → send first reminder now,
    // schedule the next one for 1 hour from now.
    sendImmediately = true;
    nextReminderAt  = new Date(now.getTime() + 60 * 60_000);
    // But if next-hourly would be past or equal to warningAt, cap it:
    if (nextReminderAt >= warningAt) {
      // No more hourly reminders between now and the warning
      nextReminderAt = warningAt; // will trigger warning transition on next cron
    }
  } else {
    // Quiet hours or deferred — set first reminder to 6 AM on the warning day
    sendImmediately = false;
    const { year, month, day } = localParts(warningAt, tz);
    nextReminderAt = localToUTC(year, month, day, 6, 0, tz);
  }

  return { warningAt, homeownerNotifyAt, nextReminderAt, sendImmediately };
}

/**
 * Given the current time and a contractor's timezone, compute the UTC timestamp
 * of the next hourly reminder (skips quiet hours and stays before warningAt).
 */
function nextHourlyReminder(now: Date, tz: string, warningAt: Date): Date {
  const oneHourLater = new Date(now.getTime() + 60 * 60_000);

  // If the next hourly would reach or pass the warning time, return warningAt
  // so the cron will pick it up and transition to warning phase.
  if (oneHourLater >= warningAt) return warningAt;

  if (!isQuiet(oneHourLater, tz)) return oneHourLater;

  // Next reminder falls in quiet hours → jump to 6 AM local time
  // Try today's 6 AM first
  const { year, month, day } = localParts(now, tz);
  let sixAM = localToUTC(year, month, day, 6, 0, tz);
  if (sixAM <= now) {
    // Already past 6 AM today → tomorrow 6 AM
    const tomorrow = addDays(now, 1);
    const p = localParts(tomorrow, tz);
    sixAM = localToUTC(p.year, p.month, p.day, 6, 0, tz);
  }
  return sixAM;
}

// ═══════════════════════════════════════════════════════════
// ── EMAIL HELPER (Mailgun) ──
// ═══════════════════════════════════════════════════════════

async function sendEmail(to: string, subject: string, html: string, from?: string): Promise<boolean> {
  const key    = Deno.env.get("MAILGUN_API_KEY");
  const domain = Deno.env.get("MAILGUN_DOMAIN") || "mail.otterquote.com";

  if (!key) { console.error("MAILGUN_API_KEY not set"); return false; }

  const body = new URLSearchParams();
  body.append("from",    from || `OtterQuote <noreply@${domain}>`);
  body.append("to",      to);
  body.append("subject", subject);
  body.append("html",    html);

  try {
    const r = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`api:${key}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!r.ok) { console.error(`Mailgun error (${r.status}):`, await r.text()); return false; }
    return true;
  } catch (e) { console.error("Mailgun send error:", e); return false; }
}

/** Send to every address in a list. Deduplicates silently. Returns count sent. */
async function sendEmailToAll(addresses: string[], subject: string, html: string): Promise<number> {
  const seen = new Set<string>();
  let count = 0;
  for (const addr of addresses) {
    const clean = addr?.trim().toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    const ok = await sendEmail(addr.trim(), subject, html);
    if (ok) count++;
  }
  return count;
}

// ═══════════════════════════════════════════════════════════
// ── SMS HELPER (Twilio direct) ──
// ═══════════════════════════════════════════════════════════

async function sendSMS(to: string, message: string): Promise<boolean> {
  const sid    = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token  = Deno.env.get("TWILIO_AUTH_TOKEN");
  const svcSid = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID");
  const from   = Deno.env.get("TWILIO_PHONE_NUMBER");

  if (!sid || !token) { console.warn("Twilio credentials not set — skipping SMS"); return false; }
  if (!svcSid && !from) { console.warn("No Twilio sender configured — skipping SMS"); return false; }

  const body = new URLSearchParams();
  body.append("To", to);
  body.append("Body", message);
  if (svcSid) body.append("MessagingServiceSid", svcSid);
  else body.append("From", from!);

  try {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      }
    );
    if (!r.ok) { console.error(`Twilio error (${r.status}):`, await r.text()); return false; }
    const data = await r.json();
    console.log("SMS sent. SID:", data.sid, "to:", to);
    return true;
  } catch (e) { console.error("Twilio send error:", e); return false; }
}

/** Send SMS to every phone in a list. Deduplicates. Returns count sent. */
async function sendSMSToAll(phones: string[], message: string): Promise<number> {
  const seen = new Set<string>();
  let count = 0;
  for (const phone of phones) {
    const clean = phone?.trim().replace(/\D/g, "");
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    // Ensure E.164 format
    const e164 = clean.startsWith("1") && clean.length === 11 ? `+${clean}` :
                 clean.length === 10 ? `+1${clean}` : `+${clean}`;
    const ok = await sendSMS(e164, message);
    if (ok) count++;
  }
  return count;
}

// ═══════════════════════════════════════════════════════════
// ── COLLECT CONTRACTOR CONTACT INFO ──
// ═══════════════════════════════════════════════════════════

interface ContactInfo {
  emails: string[];
  phones: string[];
}

async function getContractorContacts(contractor: Record<string, any>, supabase: any): Promise<ContactInfo> {
  const emails: string[] = [];
  const phones: string[] = [];

  // Primary email from contractors table
  if (contractor.email) emails.push(contractor.email);

  // notification_emails array
  if (Array.isArray(contractor.notification_emails)) {
    emails.push(...contractor.notification_emails.filter(Boolean));
  }

  // notification_phones array
  if (Array.isArray(contractor.notification_phones)) {
    phones.push(...contractor.notification_phones.filter(Boolean));
  }

  // Profile email + phone (primary account)
  if (contractor.user_id) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("email, phone")
      .eq("id", contractor.user_id)
      .single();

    if (profile?.email) emails.push(profile.email);
    if (profile?.phone) phones.push(profile.phone);
  }

  return { emails, phones };
}

// ═══════════════════════════════════════════════════════════
// ── MESSAGE TEXT ──
// ═══════════════════════════════════════════════════════════

const HOURLY_SMS =
  "You have a signed contract waiting for you, but your payment method has been " +
  `declined. Please visit ${SETTINGS_URL} to resolve the matter.`;

const WARNING_SMS =
  "You have a signed contract waiting for you, but your payment method has been " +
  "declined. At 10 a.m. today we will inform the client of the payment failure " +
  "and give them the option to choose another contractor. If they opt to move " +
  "forward with you, you will receive their information and be liable for all fees, " +
  "a $250 nonpayment fee, and any attorney's fees and costs associated with " +
  "collecting this amount.";

// ── HTML email templates ──

function emailWrapper(headerBg: string, headerColor: string, title: string, body: string): string {
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:${headerBg};padding:20px;border-radius:8px 8px 0 0;text-align:center;">
    <img src="${PLATFORM_URL}/img/otter-logo.svg" alt="OtterQuote" style="width:40px;height:40px;">
    <h1 style="color:${headerColor};font-size:18px;margin:10px 0 0;">${title}</h1>
  </div>
  <div style="background:#ffffff;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px;">
    ${body}
    <p style="color:#6B7280;font-size:13px;margin-top:20px;">Questions? Contact us at support@otterquote.com</p>
  </div>
</div>`.trim();
}

function hourlyReminderEmail(companyName: string): string {
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

function warningEmail(companyName: string): string {
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

function homeownerNotificationEmail(
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

function contractorLostProjectEmail(companyName: string): string {
  return emailWrapper(
    "#0B1929", "#EF4444", "Project Update",
    `<p>Hi ${companyName},</p>
     <p>The homeowner on your pending project has chosen to select a different contractor
     due to the unresolved payment issue on their file.</p>
     <p>Please update your payment method at <a href="${SETTINGS_URL}">${SETTINGS_URL}</a>
     to ensure this doesn't happen on future projects.</p>`
  );
}

function contractorProceedEmail(companyName: string): string {
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

function adminAlertEmail(subject: string, body: string): string {
  return `<div style="font-family:monospace;padding:20px;"><h2>${subject}</h2>${body}</div>`;
}

// ═══════════════════════════════════════════════════════════
// ── SIMPLE HTML RESPONSE PAGE (for homeowner CTA clicks) ──
// ═══════════════════════════════════════════════════════════

function homeownerResponsePage(title: string, message: string, isError = false): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — OtterQuote</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #F9FAFB; display: flex; justify-content: center; align-items: center;
           min-height: 100vh; margin: 0; }
    .card { background: #fff; border-radius: 12px; padding: 40px;
            max-width: 480px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { color: ${isError ? "#DC2626" : "#0B1929"}; font-size: 22px; margin: 0 0 12px; }
    p { color: #6B7280; line-height: 1.6; }
    a { color: #0369A1; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${isError ? "⚠️" : "✅"}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <p style="margin-top:24px;font-size:13px;">
      Questions? <a href="mailto:support@otterquote.com">support@otterquote.com</a>
    </p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: isError ? 400 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ═══════════════════════════════════════════════════════════
// ── MAIN HANDLER ──
// ═══════════════════════════════════════════════════════════

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Health check ping -- returns immediately without doing real work.
  // Called by platform-health-check every 15 minutes.
  try {
    const bodyPeek = await req.clone().json().catch(() => ({}));
    if (bodyPeek?.health_check === true) {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }
  } catch { /* no-op */ }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase    = createClient(supabaseUrl, supabaseKey);

  try {

    // ─────────────────────────────────────────────────────
    // MODE: HOMEOWNER CHOICE  (GET ?mode=homeowner_choice)
    // ─────────────────────────────────────────────────────
    const url    = new URL(req.url);
    const mode   = url.searchParams.get("mode");
    const choice = url.searchParams.get("choice");
    const failId = url.searchParams.get("failure_id");

    if (req.method === "GET" && mode === "homeowner_choice") {
      if (!failId || !choice) {
        return homeownerResponsePage("Invalid Link", "This link is missing required parameters. Please contact support@otterquote.com.", true);
      }
      if (choice !== "proceed" && choice !== "different") {
        return homeownerResponsePage("Invalid Choice", "Unrecognized selection. Please contact support@otterquote.com.", true);
      }

      // Fetch the failure record
      const { data: failure, error: fErr } = await supabase
        .from("payment_failures")
        .select(`
          *,
          contractors:contractor_id (id, company_name, email, notification_emails, notification_phones, user_id),
          claims:claim_id (id, property_address, status)
        `)
        .eq("id", failId)
        .single();

      if (fErr || !failure) {
        return homeownerResponsePage("Link Expired", "We couldn't find this record. It may have already been resolved. Contact support@otterquote.com.", true);
      }

      if (!["homeowner_notified", "warning_sent"].includes(failure.dunning_status)) {
        return homeownerResponsePage(
          "Already Resolved",
          "This matter has already been resolved. If you have questions, contact support@otterquote.com."
        );
      }

      const contractor = failure.contractors as any;
      const claim      = failure.claims as any;
      const contacts   = await getContractorContacts(contractor, supabase);
      const companyName = contractor?.company_name || "Your Contractor";

      if (choice === "proceed") {
        // ── Homeowner chose to move forward ──
        await supabase
          .from("payment_failures")
          .update({ dunning_status: "resolved", resolved_at: new Date().toISOString() })
          .eq("id", failId);

        // Homeowner's contact info is now released — update claim to surface it
        if (failure.claim_id) {
          await supabase
            .from("claims")
            .update({ status: "contract_signed" }) // restore signed status
            .eq("id", failure.claim_id);
        }

        // Notify contractor they're proceeding (and are on the hook for fees)
        const proceedHtml = contractorProceedEmail(companyName);
        await sendEmailToAll(contacts.emails, "Homeowner Chose to Move Forward — OtterQuote", proceedHtml);
        const proceedSMS = `OtterQuote: The homeowner has chosen to move forward with you. You are liable for all fees including the $250 nonpayment fee. Update payment at ${SETTINGS_URL}`;
        await sendSMSToAll(contacts.phones, proceedSMS);

        // Alert Dustin
        await sendEmail(
          ADMIN_EMAIL,
          `[DUNNING] Homeowner Proceeded — ${companyName} owes $250 fee + attorney fees`,
          adminAlertEmail("Homeowner Chose to Proceed", `
            <p><strong>Failure ID:</strong> ${failId}</p>
            <p><strong>Contractor:</strong> ${companyName} (${failure.contractor_id})</p>
            <p><strong>Claim:</strong> ${claim?.property_address || failure.claim_id}</p>
            <p><strong>Amount owed:</strong> $${(failure.amount_cents / 100).toFixed(2)} platform fee + $250 nonpayment fee + attorney's fees</p>
            <p><strong>Action needed:</strong> Manually collect fees and release homeowner contact info.</p>
          `)
        );

        return homeownerResponsePage(
          "Thank You",
          `We've notified ${companyName} that you'd like to proceed. They will be in touch with you shortly. You are in good hands.`
        );

      } else {
        // ── Homeowner chose a different contractor ──
        await supabase
          .from("payment_failures")
          .update({ dunning_status: "contractor_out", resolved_at: new Date().toISOString() })
          .eq("id", failId);

        // Reset claim to bidding
        if (failure.claim_id) {
          await supabase
            .from("claims")
            .update({ status: "bidding", selected_contractor_id: null, selected_bid_amount: null })
            .eq("id", failure.claim_id);

          // Restore other quotes to submitted
          await supabase
            .from("quotes")
            .update({ status: "submitted" })
            .eq("claim_id", failure.claim_id)
            .eq("status", "declined");
        }

        // Update the failed quote
        if (failure.quote_id) {
          await supabase
            .from("quotes")
            .update({ payment_status: "failed", status: "declined" })
            .eq("id", failure.quote_id);
        }

        // Notify contractor they lost the project
        const lostHtml = contractorLostProjectEmail(companyName);
        await sendEmailToAll(contacts.emails, "Project Update — OtterQuote", lostHtml);
        const lostSMS = `OtterQuote: The homeowner on your pending project has selected a different contractor due to the unresolved payment issue. Visit ${SETTINGS_URL} to update your payment method.`;
        await sendSMSToAll(contacts.phones, lostSMS);

        // Alert Dustin
        await sendEmail(
          ADMIN_EMAIL,
          `[DUNNING] Homeowner Chose Different — ${companyName} lost the project`,
          adminAlertEmail("Homeowner Chose Different Contractor", `
            <p><strong>Failure ID:</strong> ${failId}</p>
            <p><strong>Contractor:</strong> ${companyName} (${failure.contractor_id})</p>
            <p><strong>Claim:</strong> ${claim?.property_address || failure.claim_id}</p>
            <p><strong>Result:</strong> Claim reset to bidding. Contractor notified.</p>
          `)
        );

        return homeownerResponsePage(
          "Request Received",
          "We've received your selection. Your project has been reset for rebidding. " +
          "We'll keep you updated as other contractors submit bids."
        );
      }
    }

    // ─────────────────────────────────────────────────────
    // Parse request body (TRIGGER vs CRON)
    // ─────────────────────────────────────────────────────
    let body: any = null;
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch {
      // No body or invalid JSON — CRON mode
    }

    // ─────────────────────────────────────────────────────
    // MODE: TRIGGER — Payment just failed
    // ─────────────────────────────────────────────────────
    if (body?.quote_id && body?.contractor_id) {
      console.log("TRIGGER mode: Attempting all payment methods before dunning for quote", body.quote_id);

      const { quote_id, contractor_id, claim_id, homeowner_id, amount_cents, stripe_error } = body;
      const now = new Date();

      // ── MULTI-METHOD RETRY: Try ALL payment methods before initiating dunning ──
      // This ensures dunning only triggers when every method on file has failed.
      const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
      if (stripeSecretKey) {
        const basicAuth = btoa(`${stripeSecretKey}:`);

        // Get contractor's Stripe customer ID
        const { data: cData } = await supabase
          .from("contractors")
          .select("stripe_customer_id, stripe_payment_method_id")
          .eq("id", contractor_id)
          .single();

        if (cData?.stripe_customer_id) {
          // Fetch all payment methods from the multi-method table
          const { data: allMethods } = await supabase
            .from("contractor_payment_methods")
            .select("*")
            .eq("contractor_id", contractor_id)
            .order("is_default", { ascending: false })
            .order("payment_type", { ascending: true });

          interface RetryMethod {
            stripe_pm_id: string;
            payment_type: string;
            cpm_id: string | null;
          }

          const retryMethods: RetryMethod[] = [];

          if (allMethods && allMethods.length > 0) {
            // Order: default first, then ACH, then cards
            const defaultM = allMethods.find(m => m.is_default);
            const rest = allMethods.filter(m => !m.is_default);
            const ach = rest.filter(m => m.payment_type === "us_bank_account");
            const cards = rest.filter(m => m.payment_type === "card");

            if (defaultM) retryMethods.push({ stripe_pm_id: defaultM.stripe_payment_method_id, payment_type: defaultM.payment_type, cpm_id: defaultM.id });
            for (const m of ach) if (!defaultM || m.id !== defaultM.id) retryMethods.push({ stripe_pm_id: m.stripe_payment_method_id, payment_type: m.payment_type, cpm_id: m.id });
            for (const m of cards) if (!defaultM || m.id !== defaultM.id) retryMethods.push({ stripe_pm_id: m.stripe_payment_method_id, payment_type: m.payment_type, cpm_id: m.id });
          } else if (cData.stripe_payment_method_id) {
            retryMethods.push({ stripe_pm_id: cData.stripe_payment_method_id, payment_type: "card", cpm_id: null });
          }

          // Skip the method that already failed (passed in stripe_error context)
          // and try remaining methods
          const failedMethodDetails: string[] = [];

          for (const method of retryMethods) {
            // Calculate charge amount (ACH = exact, card = add processing fee)
            let chargeAmount = amount_cents;
            let cardFee = 0;
            if (method.payment_type === "card") {
              chargeAmount = Math.ceil((amount_cents + 30) / (1 - 0.029));
              cardFee = chargeAmount - amount_cents;
            }

            const formData = new URLSearchParams();
            formData.append("amount", String(chargeAmount));
            formData.append("currency", "usd");
            formData.append("customer", cData.stripe_customer_id);
            formData.append("payment_method", method.stripe_pm_id);
            formData.append("off_session", "true");
            formData.append("confirm", "true");
            formData.append("description", `OtterQuote platform fee — quote ${quote_id.substring(0, 8)}`);
            formData.append("metadata[claim_id]", claim_id || "");
            formData.append("metadata[type]", "platform_fee");
            formData.append("metadata[contractor_id]", contractor_id);
            formData.append("metadata[payment_type]", method.payment_type);
            formData.append("metadata[platform_fee_cents]", String(amount_cents));
            if (method.payment_type === "us_bank_account") {
              formData.append("payment_method_types[]", "us_bank_account");
            } else {
              formData.append("payment_method_types[]", "card");
            }

            try {
              const resp = await fetch(`${STRIPE_API_BASE}/payment_intents`, {
                method: "POST",
                headers: {
                  Authorization: `Basic ${basicAuth}`,
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: formData.toString(),
              });

              const respData = await resp.json();

              if (resp.ok && respData.status !== "requires_action" && respData.status !== "requires_payment_method") {
                // SUCCESS — payment went through on a retry method
                console.log(`Dunning AVOIDED: Payment succeeded on method ${method.stripe_pm_id} (${method.payment_type}). PI: ${respData.id}`);

                // Update quote with payment info
                const quoteUpdate: Record<string, any> = {
                  payment_intent_id: respData.id,
                  payment_status: "paid",
                  payment_method_type: method.payment_type,
                };
                if (method.cpm_id) quoteUpdate.payment_method_id = method.cpm_id;
                if (cardFee > 0) quoteUpdate.card_fee_cents = cardFee;

                await supabase.from("quotes").update(quoteUpdate).eq("id", quote_id);

                return new Response(
                  JSON.stringify({
                    success: true,
                    dunning_avoided: true,
                    payment_intent_id: respData.id,
                    payment_method_type: method.payment_type,
                    message: `Payment succeeded on alternate method (${method.payment_type}). Dunning not initiated.`,
                  }),
                  { headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
              }

              // This method also failed
              const errMsg = respData?.error?.message || respData.status || "unknown";
              failedMethodDetails.push(`${method.payment_type}(****${method.stripe_pm_id.slice(-4)}): ${errMsg}`);

              // Cancel stuck intent
              if (respData.id && (respData.status === "requires_action" || respData.status === "requires_payment_method")) {
                try {
                  await fetch(`${STRIPE_API_BASE}/payment_intents/${respData.id}/cancel`, {
                    method: "POST",
                    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
                  });
                } catch (_) { /* non-fatal */ }
              }

            } catch (fetchErr) {
              failedMethodDetails.push(`${method.payment_type}(****${method.stripe_pm_id.slice(-4)}): ${fetchErr}`);
            }
          }

          // All methods failed — log which ones and proceed to dunning
          if (failedMethodDetails.length > 0) {
            console.log(`All ${retryMethods.length} payment methods failed. Proceeding to dunning. Details: ${failedMethodDetails.join("; ")}`);
          }
        }
      }

      // ── All payment methods exhausted (or no methods on file) — initiate dunning ──

      // Look up contractor (including timezone + address_state for derivation)
      const { data: contractor } = await supabase
        .from("contractors")
        .select("id, company_name, email, notification_emails, notification_phones, user_id, timezone, address_state")
        .eq("id", contractor_id)
        .single();

      const tz = resolveTimezone(contractor?.timezone ?? null, contractor?.address_state ?? null);

      // Persist the resolved timezone back to the contractors record if it was blank
      if (contractor && (!contractor.timezone || contractor.timezone === "America/New_York") && contractor.address_state) {
        const derived = resolveTimezone(null, contractor.address_state);
        if (derived !== "America/New_York") {
          await supabase.from("contractors").update({ timezone: derived }).eq("id", contractor_id);
        }
      }

      // Compute dunning schedule
      const { warningAt, homeownerNotifyAt, nextReminderAt, sendImmediately } = computeSchedule(now, tz);

      // Look up claim for context
      const { data: claim } = await supabase
        .from("claims")
        .select("property_address")
        .eq("id", claim_id)
        .single();

      const companyName = contractor?.company_name || "Contractor";
      const projectDesc = claim?.property_address ? `project at ${claim.property_address}` : `quote ${quote_id.substring(0, 8)}`;
      const feeFormatted = `$${(amount_cents / 100).toFixed(2)}`;

      // Create payment_failures record
      const { data: failureRecord, error: insertError } = await supabase
        .from("payment_failures")
        .insert({
          quote_id,
          contractor_id,
          claim_id,
          homeowner_id,
          amount_cents,
          stripe_error:       stripe_error || "Payment declined",
          dunning_status:     "active",
          contractor_timezone: tz,
          next_reminder_at:   nextReminderAt.toISOString(),
          warning_at:         warningAt.toISOString(),
          homeowner_notify_at: homeownerNotifyAt.toISOString(),
          reminder_count:     0,
        })
        .select()
        .single();

      if (insertError) throw new Error(`Failed to create payment_failures record: ${insertError.message}`);

      // Update quote payment status
      await supabase.from("quotes").update({ payment_status: "dunning" }).eq("id", quote_id);

      // Collect all contact info
      const contacts = contractor ? await getContractorContacts(contractor as any, supabase) : { emails: [], phones: [] };

      // Send first notification immediately if applicable
      if (sendImmediately && contacts.emails.length > 0) {
        const html = hourlyReminderEmail(companyName);
        const sent = await sendEmailToAll(contacts.emails, "Action Required: Payment Declined — OtterQuote", html);
        await sendSMSToAll(contacts.phones, HOURLY_SMS);

        // Update reminder count
        await supabase
          .from("payment_failures")
          .update({ reminder_count: 1 })
          .eq("id", failureRecord.id);

        console.log(`Trigger: sent immediate reminder to ${sent} email(s) for failure ${failureRecord.id}`);
      } else {
        console.log(`Trigger: deferred — first reminder scheduled for ${nextReminderAt.toISOString()}`);
      }

      // In-app notification for contractor
      if (contractor?.user_id) {
        await supabase.from("notifications").insert({
          user_id:           contractor.user_id,
          notification_type: "payment_failed",
          channel:           "dashboard",
          title:             "Payment Declined",
          message:           `Your payment of ${feeFormatted} for the ${projectDesc} was declined. Please update your payment method.`,
          metadata: { quote_id, claim_id, failure_id: failureRecord.id, amount_cents },
        });
      }

      return new Response(
        JSON.stringify({
          success: true,
          failure_id:     failureRecord.id,
          timezone:       tz,
          next_reminder:  nextReminderAt.toISOString(),
          warning_at:     warningAt.toISOString(),
          homeowner_notify_at: homeownerNotifyAt.toISOString(),
          sent_immediately: sendImmediately,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─────────────────────────────────────────────────────
    // MODE: CRON — Process all active dunning records
    // ─────────────────────────────────────────────────────
    console.log("CRON mode: Scanning active dunning records...");
    const now = new Date();
    let processed = 0;

    // ── PASS 1: Active records — hourly reminders and warning transitions ──
    const { data: activeFailures, error: fetchErr } = await supabase
      .from("payment_failures")
      .select(`
        *,
        contractors:contractor_id (
          id, company_name, email, notification_emails, notification_phones,
          user_id, timezone, address_state
        ),
        claims:claim_id (id, property_address, status)
      `)
      .eq("dunning_status", "active")
      .lte("next_reminder_at", now.toISOString())
      .order("next_reminder_at", { ascending: true });

    if (fetchErr) throw new Error(`Failed to fetch active dunning records: ${fetchErr.message}`);

    for (const failure of (activeFailures || [])) {
      const contractor  = failure.contractors as any;
      const claim       = failure.claims as any;
      const companyName = contractor?.company_name || "Contractor";
      const projectDesc = claim?.property_address ? `project at ${claim.property_address}` : `quote ${failure.quote_id?.substring(0, 8)}`;
      const tz          = failure.contractor_timezone || resolveTimezone(contractor?.timezone ?? null, contractor?.address_state ?? null);
      const warningAt   = new Date(failure.warning_at);

      // Collect contacts
      const contacts = contractor ? await getContractorContacts(contractor, supabase) : { emails: [], phones: [] };

      if (now >= warningAt) {
        // ── TRANSITION: Send 8 AM warning, stop hourly reminders ──
        console.log(`Sending 8 AM WARNING for failure ${failure.id}`);

        const html = warningEmail(companyName);
        await sendEmailToAll(contacts.emails, "Final Notice: Payment Still Declined — OtterQuote", html);
        await sendSMSToAll(contacts.phones, WARNING_SMS);

        // Advance status — clear next_reminder_at to stop hourly loop
        await supabase
          .from("payment_failures")
          .update({
            dunning_status:  "warning_sent",
            next_reminder_at: null,
          })
          .eq("id", failure.id);

        console.log(`8 AM warning sent for failure ${failure.id}. Hourly reminders stopped.`);

      } else {
        // ── HOURLY REMINDER ──
        console.log(`Sending hourly reminder #${failure.reminder_count + 1} for failure ${failure.id}`);

        const html = hourlyReminderEmail(companyName);
        await sendEmailToAll(contacts.emails, "Payment Action Required — OtterQuote", html);
        await sendSMSToAll(contacts.phones, HOURLY_SMS);

        const nextReminder = nextHourlyReminder(now, tz, warningAt);

        await supabase
          .from("payment_failures")
          .update({
            reminder_count:   failure.reminder_count + 1,
            next_reminder_at: nextReminder.toISOString(),
          })
          .eq("id", failure.id);
      }

      processed++;
    }

    // ── PASS 2: warning_sent records ready for homeowner notification ──
    const { data: warnedFailures, error: warnErr } = await supabase
      .from("payment_failures")
      .select(`
        *,
        contractors:contractor_id (id, company_name),
        claims:claim_id (id, property_address, status)
      `)
      .eq("dunning_status", "warning_sent")
      .lte("homeowner_notify_at", now.toISOString());

    if (warnErr) throw new Error(`Failed to fetch warning_sent records: ${warnErr.message}`);

    for (const failure of (warnedFailures || [])) {
      const contractor  = failure.contractors as any;
      const companyName = contractor?.company_name || "Contractor";

      if (!failure.homeowner_id) {
        console.warn(`failure ${failure.id} has no homeowner_id — skipping homeowner notification`);
        // Still advance status so we don't retry forever
        await supabase
          .from("payment_failures")
          .update({ dunning_status: "homeowner_notified" })
          .eq("id", failure.id);
        continue;
      }

      // Look up homeowner profile
      const { data: hwProfile } = await supabase
        .from("profiles")
        .select("email, full_name")
        .eq("id", failure.homeowner_id)
        .single();

      if (hwProfile?.email) {
        const homeownerName = hwProfile.full_name || "there";
        const html = homeownerNotificationEmail(homeownerName, companyName, failure.id, supabaseUrl);
        await sendEmail(
          hwProfile.email,
          "Important Update on Your Project — OtterQuote",
          html
        );
        console.log(`Homeowner notification sent for failure ${failure.id} to ${hwProfile.email}`);
      }

      // Alert Dustin
      const claim = failure.claims as any;
      await sendEmail(
        ADMIN_EMAIL,
        `[DUNNING] Homeowner Notified — ${companyName} — ${claim?.property_address || failure.claim_id}`,
        adminAlertEmail("Homeowner Notified (10 AM)", `
          <p><strong>Failure ID:</strong> ${failure.id}</p>
          <p><strong>Contractor:</strong> ${companyName} (${failure.contractor_id})</p>
          <p><strong>Claim:</strong> ${claim?.property_address || failure.claim_id}</p>
          <p><strong>Amount:</strong> $${(failure.amount_cents / 100).toFixed(2)}</p>
          <p><strong>Reminders sent:</strong> ${failure.reminder_count}</p>
          <p>Homeowner has been emailed with two CTAs. Waiting for their choice.</p>
        `)
      );

      await supabase
        .from("payment_failures")
        .update({ dunning_status: "homeowner_notified" })
        .eq("id", failure.id);

      processed++;
    }

    console.log(`CRON complete: ${processed} records processed.`);

    return new Response(
      JSON.stringify({
        processed,
        active_processed: activeFailures?.length || 0,
        homeowner_notified: warnedFailures?.length || 0,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("process-dunning error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
