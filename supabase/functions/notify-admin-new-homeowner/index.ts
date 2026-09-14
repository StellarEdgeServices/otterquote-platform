/**
 * OtterQuote Edge Function: notify-admin-new-homeowner
 *
 * Sends an admin notification email to Dustin whenever a real homeowner
 * creates a claim (claims insert), AND runs a deferred "signup sweep" every
 * 15 minutes (pg_cron -> this EF in `signup_sweep` mode) so a homeowner who
 * signs up but never files a claim still surfaces. Filed for gh-1932.
 *
 * History (see PR #1934 / issue #1932 comments for full evidence):
 *  - Pass 1: alerted on both profiles-insert (role='homeowner') and claims-insert.
 *  - Rework 1 (refuter FAIL): profiles.role defaults to 'homeowner' for EVERY
 *    new auth user (no signup-time signal distinguishes homeowner from
 *    contractor — confirmed by reading js/auth.js signUpWithPassword, which
 *    never sets options.data), so the profiles trigger false-positived on
 *    every contractor signup. Dropped the profiles-insert trigger; claims-only.
 *  - Rework 2 (refuter-2 FAIL on SCOPE, CEO-ratified per issue #1932 comment
 *    5670873022): claims-only silently drops the "someone is IN the system"
 *    half of the deliverable Dustin asked for — 18 live role='homeowner'
 *    profiles have zero claims and would never alert. CEO ruling: keep
 *    claims-only trigger AND add a DEFERRED SWEEP (this rework) that finds
 *    homeowner profiles 20min-7d old with no contractors row (the real,
 *    verified signal a contractor signup creates: trg_sync_contractor_profile_role
 *    fires AFTER INSERT ON public.contractors, keyed by contractors.user_id =
 *    profiles.id — confirmed via information_schema), not excluded, and not
 *    yet alerted -> alerts once each. The sweep's FIRST EVER run sends one
 *    digest (not N individual emails) for the pre-existing backlog, then
 *    marks each as alerted so later runs only see genuinely new signups.
 *    Also: the exclusion filter was an unanchored `.includes("test")`,
 *    which silently dropped real homeowners whose address merely contains
 *    "test" (5 confirmed live, e.g. "protest..."/"greatest..."-shaped local
 *    parts) — replaced with an anchored pattern in this rework (see
 *    isExcludedEmail below): local part exactly "test", local part starting
 *    "test" + [0-9+._-], "+test" anywhere, or domain in
 *    example.com/example.org/test.local. is_test=true is still excluded
 *    unconditionally, as are the admin/internal domains.
 *
 * Trigger sources:
 *  1. trg_notify_admin_new_claim (AFTER INSERT ON claims) -> pg_net ->
 *     POSTs {event_type:"claim_created", record}.
 *  2. pg_cron job "gh1932-homeowner-signup-sweep" (every 15 minutes) -> pg_net ->
 *     POSTs {event_type:"signup_sweep"} with no record; this EF does its own
 *     candidate selection with the service-role client.
 *
 * Auth model: accepts the Supabase service role key as bearer token
 * (both trigger and cron paths). ALSO accepts the anon key — a deliberate,
 * documented extension so manual/test invocations never need to handle the
 * service-role secret.
 *
 * Idempotency (notifications table):
 *   claim_created -> skips if notification_type=admin_new_claim already
 *                    exists for claim_id = record.id
 *   signup_sweep, per-profile -> skips a profile if notification_type=
 *                    admin_new_homeowner already exists for user_id = profile.id
 *   signup_sweep, digest gate -> the one-time backlog digest is sent only if
 *                    no notification_type=admin_homeowner_signup_digest row
 *                    exists yet (any row, checked without a user_id filter).
 *
 * Test / internal-account filter (gh-1932 rework 2, anchored):
 *   is_test = true (unconditional), OR email matches (case-insensitive):
 *     local part exactly "test"        e.g. test@x.com
 *     local part "test" + [0-9+._-]    e.g. test1@, test+x@, test.x@, test-x@
 *     "+test" anywhere in local part   e.g. dustin+test@gmail.com
 *     domain in example.com / example.org / test.local
 *     @otterquote.com / @tryotterquote.com / @stellaredgeservices.com
 *     email contains "stohler" (internal/founder accounts)
 *   A real address that merely CONTAINS "test" (e.g. a "greatestates@" or
 *   "protest@" style local part) is NOT excluded by this pattern.
 *
 * Environment variables (all already set in Supabase secrets):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN
 *
 * Refs #1932
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

const ADMIN_EMAIL      = "dustinstohler1@gmail.com";
const ADMIN_PORTAL_URL = "https://otterquote.com/admin-dashboard.html";

const NOTIF_TYPE_HOMEOWNER = "admin_new_homeowner";
const NOTIF_TYPE_CLAIM     = "admin_new_claim";
const NOTIF_TYPE_DIGEST    = "admin_homeowner_signup_digest";

const DEFAULT_MIN_AGE_MINUTES = 20;
const MAX_AGE_DAYS            = 7;

// CORS — origin-allowlisted per project standard (Session 254), copied
// from notify-admin-new-contractor.
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

// gh-1932 rework 2: anchored exclusion filter (see doc header for the exact
// spec). Deliberately does NOT match a real address that merely contains
// "test" as a substring.
function isExcludedEmail(email: string): boolean {
  const lower = (email || "").toLowerCase().trim();
  if (!lower || lower.indexOf("@") <= 0) return true; // no usable address
  const at = lower.indexOf("@");
  const local  = lower.slice(0, at);
  const domain = lower.slice(at + 1);

  if (local === "test") return true;
  if (/^test[0-9+._-]/.test(local)) return true;
  if (local.includes("+test")) return true;
  if (["example.com", "example.org", "test.local"].includes(domain)) return true;
  if (domain === "otterquote.com" || domain === "tryotterquote.com" || domain === "stellaredgeservices.com") return true;
  if (lower.includes("stohler")) return true;

  return false;
}

function maskEmail(email: string): string {
  const at = (email || "").indexOf("@");
  if (at <= 0) return "(no email)";
  return `${email[0]}***${email.slice(at)}`;
}

function escapeHtml(str: string): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmailHtml(heading: string, rows: [string, string][], extraHtml?: string): string {
  const rowsHtml = rows
    .map(
      ([label, value]) => `
              <tr>
                <td style="padding:8px 0;color:#64748B;width:130px;vertical-align:top;">${escapeHtml(label)}</td>
                <td style="padding:8px 0;">${value}</td>
              </tr>`,
    )
    .join("");
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td style="background:#0B1929;padding:20px 24px;">
            <h2 style="color:#F59E0B;margin:0;font-size:1.1rem;font-family:sans-serif;">
              🦦 ${escapeHtml(heading)}
            </h2>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;font-family:sans-serif;color:#0B1929;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="border-collapse:collapse;font-size:14px;margin-bottom:24px;">${rowsHtml}
            </table>
            ${extraHtml || ""}
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#F59E0B" style="border-radius:8px;">
                  <a href="${ADMIN_PORTAL_URL}"
                     style="display:inline-block;font-family:sans-serif;font-size:15px;font-weight:700;
                            color:#0B1929;text-decoration:none;padding:12px 24px;">
                    Open Admin Dashboard &rarr;
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center"
              style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px;
                     font-family:sans-serif;font-size:12px;color:#94A3B8;">
            Otter Quotes &nbsp;|&nbsp;
            <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

type NormalizedEvent =
  | { eventType: "claim_created"; record: Record<string, unknown> }
  | { eventType: "signup_sweep"; minAgeMinutes: number };

function normalizeBody(body: any): NormalizedEvent | null {
  if (!body || typeof body !== "object") return null;

  if (body.event_type === "claim_created") {
    if (!body.record || typeof body.record !== "object") return null;
    return { eventType: "claim_created", record: body.record };
  }

  if (body.event_type === "signup_sweep") {
    const minAgeMinutes =
      typeof body.min_age_minutes === "number" && body.min_age_minutes >= 0
        ? body.min_age_minutes
        : DEFAULT_MIN_AGE_MINUTES;
    return { eventType: "signup_sweep", minAgeMinutes };
  }

  // Supabase native database-webhook shape: {type:"INSERT", table, record}
  if (body.type === "INSERT" && body.record && typeof body.record === "object" && body.table === "claims") {
    return { eventType: "claim_created", record: body.record };
  }

  return null;
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const anonKey         = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const supabaseUrl     = Deno.env.get("SUPABASE_URL") || "";
    const mailgunKey      = Deno.env.get("MAILGUN_API_KEY") || "";
    const mailgunDomain   = Deno.env.get("MAILGUN_DOMAIN") || "";

    if (!serviceRoleKey || !supabaseUrl || !mailgunKey || !mailgunDomain) {
      throw new Error("Missing required environment variables");
    }

    const authHeader  = req.headers.get("Authorization") || "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
    const authorized =
      !!bearerToken && (bearerToken === serviceRoleKey || (!!anonKey && bearerToken === anonKey));
    if (!authorized) {
      console.error("notify-admin-new-homeowner: unauthorized");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const rawBody = await req.json().catch(() => ({}));
    const normalized = normalizeBody(rawBody);
    if (!normalized) {
      return new Response(
        JSON.stringify({ error: "Missing or unrecognized event_type/record payload" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const sb = createClient(supabaseUrl, serviceRoleKey);

    if (normalized.eventType === "signup_sweep") {
      return await handleSignupSweep(sb, normalized.minAgeMinutes, mailgunDomain, mailgunKey, corsHeaders);
    }

    // eventType === "claim_created"
    const { record } = normalized;
    const claimId = record.id as string | undefined;
    const userId  = record.user_id as string | undefined;
    if (!claimId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: record.id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let email = "";
    let profileIsTest = false;
    let profileFullName = "";
    if (userId) {
      const { data: profile } = await sb
        .from("profiles")
        .select("email, is_test, full_name")
        .eq("id", userId)
        .maybeSingle();
      email           = profile?.email || "";
      profileIsTest   = profile?.is_test === true;
      profileFullName = profile?.full_name || "";
    }

    const claimIsTest = record.is_test === true;

    if (claimIsTest || profileIsTest || isExcludedEmail(email)) {
      console.log(`notify-admin-new-homeowner: skipping test/excluded claim ${claimId} (${email})`);
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "test_account" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: existing } = await sb
      .from("notifications")
      .select("id")
      .eq("claim_id", claimId)
      .eq("notification_type", NOTIF_TYPE_CLAIM)
      .eq("channel", "email")
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`notify-admin-new-homeowner: already sent for claim_id=${claimId}`);
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "already_notified" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const claimNumber = (record.claim_number as string) || claimId;
    const homeownerName = (record.homeowner_name as string) || profileFullName || "(no name given)";
    const propertyAddrParts = [record.property_address, record.property_state]
      .filter(Boolean)
      .join(", ");
    const propertyAddr = propertyAddrParts || "location not yet provided";
    const createdTs = record.created_at
      ? new Date(record.created_at as string).toLocaleString("en-US", { timeZone: "America/Chicago" })
      : new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
    const maskedEmail = maskEmail(email);

    const subject  = `[OtterQuote] New claim #${claimNumber} from ${maskedEmail}`;
    const textBody = [
      `A new claim was created on Otter Quotes.`,
      `Claim    : #${claimNumber}`,
      `Homeowner: ${homeownerName} (${maskedEmail})`,
      `Created  : ${createdTs} CT`,
      `Property : ${propertyAddr}`,
      ``,
      `Open the admin dashboard:`,
      ADMIN_PORTAL_URL,
    ].join("\n");
    const htmlBody = buildEmailHtml("New Claim Created", [
      ["Claim", `#${escapeHtml(claimNumber)}`],
      ["Homeowner", `${escapeHtml(homeownerName)} (${escapeHtml(maskedEmail)})`],
      ["Created", `${escapeHtml(createdTs)} CT`],
      ["Property", escapeHtml(propertyAddr)],
    ]);

    const mgData = await sendMail(mailgunDomain, mailgunKey, subject, textBody, htmlBody);

    await sb.from("notifications").insert({
      user_id:           userId || null,
      claim_id:          claimId,
      channel:           "email",
      notification_type: NOTIF_TYPE_CLAIM,
      recipient:         ADMIN_EMAIL,
      message_preview:   `New claim #${claimNumber} from ${maskedEmail}`,
      sent_at:           new Date().toISOString(),
      delivered:         true,
      mailgun_id:        mgData.id,
    }).then(({ error }) => {
      if (error) console.warn(`notify-admin-new-homeowner: failed to log notification for claim_id=${claimId}:`, error);
    });

    return new Response(
      JSON.stringify({ success: true, mailgun_id: mgData.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (err) {
    console.error("notify-admin-new-homeowner error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// gh-1932 rework 2: deferred signup sweep. Selects role='homeowner' profiles
// between minAgeMinutes and MAX_AGE_DAYS old, with no matching contractors
// row, not excluded/is_test, and not yet alerted. First-ever run (no
// NOTIF_TYPE_DIGEST row exists) sends ONE digest for the whole backlog
// instead of one email per profile. Every subsequent run alerts newly
// eligible profiles individually (normally 0 or 1 per run).
async function handleSignupSweep(
  sb: ReturnType<typeof createClient>,
  minAgeMinutes: number,
  mailgunDomain: string,
  mailgunKey: string,
  corsHeaders: Record<string, string>,
) {
  const now = Date.now();
  const upperBound = new Date(now - minAgeMinutes * 60_000).toISOString();       // created_at <= this (old enough)
  const lowerBound = new Date(now - MAX_AGE_DAYS * 24 * 60 * 60_000).toISOString(); // created_at >= this (not stale)

  const { data: candidates, error: candErr } = await sb
    .from("profiles")
    .select("id, email, full_name, address_city, address_state, address_zip, created_at, is_test")
    .eq("role", "homeowner")
    .gte("created_at", lowerBound)
    .lte("created_at", upperBound);

  if (candErr) {
    console.error("notify-admin-new-homeowner: sweep candidate query failed:", candErr);
    return new Response(
      JSON.stringify({ error: "sweep candidate query failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const ids = (candidates || []).map((c: any) => c.id);
  let contractorIds = new Set<string>();
  if (ids.length > 0) {
    const { data: contractorRows } = await sb.from("contractors").select("user_id").in("user_id", ids);
    contractorIds = new Set((contractorRows || []).map((r: any) => r.user_id));
  }

  // anchored exclusion filter (SQL-equivalent pattern, applied here in TS
  // over the already-narrowed candidate set — see isExcludedEmail doc header)
  const eligible = (candidates || []).filter(
    (c: any) => !contractorIds.has(c.id) && c.is_test !== true && !isExcludedEmail(c.email || ""),
  );

  let alreadyAlertedIds = new Set<string>();
  if (eligible.length > 0) {
    const { data: alertedRows } = await sb
      .from("notifications")
      .select("user_id")
      .eq("notification_type", NOTIF_TYPE_HOMEOWNER)
      .in("user_id", eligible.map((e: any) => e.id));
    alreadyAlertedIds = new Set((alertedRows || []).map((r: any) => r.user_id));
  }

  const toAlert = eligible.filter((e: any) => !alreadyAlertedIds.has(e.id));

  const { data: digestRows } = await sb
    .from("notifications")
    .select("id")
    .eq("notification_type", NOTIF_TYPE_DIGEST)
    .limit(1);
  const digestAlreadySent = !!digestRows && digestRows.length > 0;

  if (toAlert.length === 0) {
    return new Response(
      JSON.stringify({ success: true, sweep: true, alerted: 0, digest_sent: digestAlreadySent }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const locationOf = (p: any) =>
    [p.address_city, p.address_state, p.address_zip].filter(Boolean).join(", ") || "location not yet provided";

  if (!digestAlreadySent) {
    // ONE digest email listing every backlog profile, then mark all alerted.
    const rowsHtml = toAlert
      .map((p: any) => {
        const ts = new Date(p.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" });
        return `<tr><td style="padding:4px 8px;color:#64748B;">${escapeHtml(maskEmail(p.email || ""))}</td><td style="padding:4px 8px;">${escapeHtml(ts)} CT</td><td style="padding:4px 8px;">${escapeHtml(locationOf(p))}</td></tr>`;
      })
      .join("");
    const extraHtml = `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:13px;margin-bottom:20px;border:1px solid #E2E8F0;">
      <tr style="background:#F8FAFC;"><th align="left" style="padding:6px 8px;">Email</th><th align="left" style="padding:6px 8px;">Signed up</th><th align="left" style="padding:6px 8px;">Location</th></tr>
      ${rowsHtml}
    </table>`;

    const subject  = `[OtterQuote] Homeowner signup backlog digest: ${toAlert.length} existing homeowner(s)`;
    const textLines = toAlert.map((p: any) => `- ${maskEmail(p.email || "")} | ${new Date(p.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT | ${locationOf(p)}`);
    const textBody = [
      `This is a one-time backlog digest for the gh-1932 homeowner signup sweep.`,
      `${toAlert.length} existing homeowner(s) with no claim were found and are listed below.`,
      `From now on, only NEW signups will trigger individual emails.`,
      ``,
      ...textLines,
      ``,
      `Open the admin dashboard:`,
      ADMIN_PORTAL_URL,
    ].join("\n");
    const htmlBody = buildEmailHtml(
      "Homeowner Signup Backlog Digest",
      [["Count", String(toAlert.length)]],
      extraHtml,
    );

    const mgData = await sendMail(mailgunDomain, mailgunKey, subject, textBody, htmlBody);

    await sb.from("notifications").insert({
      user_id: null, claim_id: null, channel: "email",
      notification_type: NOTIF_TYPE_DIGEST, recipient: ADMIN_EMAIL,
      message_preview: `Backlog digest: ${toAlert.length} homeowner(s)`,
      sent_at: new Date().toISOString(), delivered: true, mailgun_id: mgData.id,
    });

    // mark every backlog profile as alerted (no individual email for these)
    const markRows = toAlert.map((p: any) => ({
      user_id: p.id, claim_id: null, channel: "email",
      notification_type: NOTIF_TYPE_HOMEOWNER, recipient: ADMIN_EMAIL,
      message_preview: `Included in backlog digest`,
      sent_at: new Date().toISOString(), delivered: true, mailgun_id: mgData.id,
    }));
    if (markRows.length > 0) {
      const { error: markErr } = await sb.from("notifications").insert(markRows);
      if (markErr) console.warn("notify-admin-new-homeowner: failed to mark backlog as alerted:", markErr);
    }

    return new Response(
      JSON.stringify({ success: true, sweep: true, digest: true, count: toAlert.length, mailgun_id: mgData.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Steady state: individual email per newly-eligible profile.
  let lastMailgunId = "";
  for (const p of toAlert) {
    const ts = new Date(p.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" });
    const maskedEmail = maskEmail(p.email || "");
    const location = locationOf(p);
    const fullName = p.full_name || "(no name given)";
    const subject  = `[OtterQuote] New homeowner: ${maskedEmail} — ${location}`;
    const textBody = [
      `A homeowner signed up on Otter Quotes and has not yet filed a claim.`,
      `Name     : ${fullName}`,
      `Email    : ${maskedEmail}`,
      `Signed up: ${ts} CT`,
      `Location : ${location}`,
      ``,
      `Open the admin dashboard:`,
      ADMIN_PORTAL_URL,
    ].join("\n");
    const htmlBody = buildEmailHtml("New Homeowner Signup", [
      ["Name", escapeHtml(fullName)],
      ["Email", escapeHtml(maskedEmail)],
      ["Signed up", `${escapeHtml(ts)} CT`],
      ["Location", escapeHtml(location)],
    ]);

    const mgData = await sendMail(mailgunDomain, mailgunKey, subject, textBody, htmlBody);
    lastMailgunId = mgData.id;

    await sb.from("notifications").insert({
      user_id: p.id, claim_id: null, channel: "email",
      notification_type: NOTIF_TYPE_HOMEOWNER, recipient: ADMIN_EMAIL,
      message_preview: `New homeowner signup: ${maskedEmail}`,
      sent_at: new Date().toISOString(), delivered: true, mailgun_id: mgData.id,
    }).then(({ error }) => {
      if (error) console.warn(`notify-admin-new-homeowner: failed to log sweep notification for user_id=${p.id}:`, error);
    });
  }

  return new Response(
    JSON.stringify({ success: true, sweep: true, alerted: toAlert.length, mailgun_id: lastMailgunId }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

async function sendMail(
  mailgunDomain: string,
  mailgunKey: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): Promise<{ id: string }> {
  const formData = new FormData();
  formData.append("from",    `Otter Quotes <notifications@${mailgunDomain}>`);
  formData.append("to",      ADMIN_EMAIL);
  formData.append("subject", subject);
  formData.append("text",    textBody);
  formData.append("html",    htmlBody);

  const mgRes = await fetch(
    `https://api.mailgun.net/v3/${mailgunDomain}/messages`,
    {
      method:  "POST",
      headers: { Authorization: `Basic ${btoa(`api:${mailgunKey}`)}` },
      body:    formData,
    },
  );

  if (!mgRes.ok) {
    const errText = await mgRes.text();
    throw new Error(`Mailgun error ${mgRes.status}: ${errText}`);
  }

  return await mgRes.json();
}
