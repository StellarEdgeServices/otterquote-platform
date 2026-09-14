/**
 * OtterQuote Edge Function: notify-admin-new-homeowner
 *
 * Sends an admin notification email to Dustin whenever a real homeowner
 * creates a claim (claims insert). Filed for gh-1932 — Part 2 of
 * ceo42-cust-visibility-20260914.md found NO push alert existed for
 * homeowner signup or claim creation; only new-contractor pushed. (First
 * pass also alerted on bare signup; dropped in the gh-1932 rework — see
 * below.)
 *
 * Pattern copied from notify-admin-new-contractor/index.ts: service-role
 * auth for the trigger path, notifications-table idempotency, test-account
 * filter, Mailgun sender. NOT called by browser clients.
 *
 * Triggered by a PostgreSQL trigger (trg_notify_admin_new_claim) via pg_net,
 * AFTER INSERT on claims — see the accompanying migration. The trigger
 * POSTs {event_type, record} where record is the new row as jsonb.
 *
 * gh-1932 rework (refuter FAIL, 2026-09-14): a second trigger on profiles
 * (AFTER INSERT WHERE role='homeowner') was built and deployed in the first
 * pass, then DROPPED — there is no reliable per-request signal for
 * "homeowner" at auth signup time. Confirmed by reading the real signup
 * path (js/auth.js signUpWithPassword -> sb.auth.signUp with no
 * options.data at all) and the schema: profiles.role defaults to
 * 'homeowner' for EVERY new auth user (text NOT NULL DEFAULT 'homeowner'),
 * and a contractor's row only becomes role='contractor' via a SEPARATE,
 * later INSERT into public.contractors (trg_sync_contractor_profile_role),
 * observed live 2s-31min after the profiles row was created. Gating the
 * trigger on profiles.role at INSERT time therefore fired "New homeowner"
 * for every contractor signup too (confirmed: role default made this
 * unconditional). auth-callback.html's `intent` query param is a
 * client-side-only routing hint, never persisted to any column the DB can
 * see. With no reliable signal, this EF now alerts on claims INSERT only
 * -- the point a homeowner is unambiguously real and engaged, and the one
 * event that also carries an address, closing the original signup path's
 * "where are they" gap too. The function still ACCEPTS event_type
 * homeowner_signup defensively (see payload tolerance below) in case a
 * future, real signal is found and a trigger/webhook is re-added, but
 * nothing in this repo currently sends it.
 *
 * Payload tolerance: also accepts Supabase's native database-webhook shape
 * {type:"INSERT", table, record} and derives event_type from table
 * ('profiles' -> homeowner_signup, 'claims' -> claim_created), so this can
 * be wired from either a hand-rolled pg_net trigger or a Database Webhook.
 *
 * Auth model: accepts the Supabase service role key as bearer token
 * (trigger path — copied verbatim from notify-admin-new-contractor).
 * ALSO accepts the Supabase anon key as bearer token — a deliberate,
 * documented extension of that model so gh-1932's own test step (manual
 * curl against this EF with the publishable/anon key, because a profiles
 * row cannot be inserted directly without a matching auth.users row — see
 * profiles_id_fkey) can exercise the real send path without ever handling
 * the service-role secret. Both values are read from the Supabase-managed
 * env vars already injected into every Edge Function; neither is
 * hardcoded here.
 *
 * Idempotency: checks the notifications table before sending —
 *   homeowner_signup -> skips if notification_type=admin_new_homeowner
 *                        already exists for user_id = record.id
 *   claim_created     -> skips if notification_type=admin_new_claim
 *                        already exists for claim_id = record.id
 *
 * Test / internal-account filter (gh-1932 spec, broader than
 * notify-admin-new-contractor's): skips when is_test = true, or email
 * matches (case-insensitive) any of:
 *   %test%  |  @otterquote.com  |  @tryotterquote.com
 *   |  @stellaredgeservices.com  |  %stohler%
 * Subject line masks the email (d***@gmail.com).
 *
 * Environment variables (all already set in Supabase secrets):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_ANON_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *
 * Refs #1932
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

const ADMIN_EMAIL      = "dustinstohler1@gmail.com";
const ADMIN_PORTAL_URL = "https://otterquote.com/admin-dashboard.html";

const NOTIF_TYPE_HOMEOWNER = "admin_new_homeowner";
const NOTIF_TYPE_CLAIM     = "admin_new_claim";

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

// gh-1932 exclusion list — is_test flag handled separately by the caller.
function isExcludedEmail(email: string): boolean {
  const lower = (email || "").toLowerCase();
  return (
    lower.includes("test") ||
    lower.endsWith("@otterquote.com") ||
    lower.endsWith("@tryotterquote.com") ||
    lower.endsWith("@stellaredgeservices.com") ||
    lower.includes("stohler")
  );
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

function buildEmailHtml(heading: string, rows: [string, string][]): string {
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

type NormalizedEvent = {
  eventType: "homeowner_signup" | "claim_created";
  record: Record<string, unknown>;
};

function normalizeBody(body: any): NormalizedEvent | null {
  if (!body || typeof body !== "object") return null;

  // Native shape this EF's own triggers send: {event_type, record}
  if (body.event_type === "homeowner_signup" || body.event_type === "claim_created") {
    if (!body.record || typeof body.record !== "object") return null;
    return { eventType: body.event_type, record: body.record };
  }

  // Supabase native database-webhook shape: {type:"INSERT", table, record}
  if (body.type === "INSERT" && body.record && typeof body.record === "object") {
    if (body.table === "profiles") {
      return { eventType: "homeowner_signup", record: body.record };
    }
    if (body.table === "claims") {
      return { eventType: "claim_created", record: body.record };
    }
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

    const rawBody = await req.json().catch(() => null);
    const normalized = normalizeBody(rawBody);
    if (!normalized) {
      return new Response(
        JSON.stringify({ error: "Missing or unrecognized event_type/record payload" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { eventType, record } = normalized;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    if (eventType === "homeowner_signup") {
      const userId  = record.id as string | undefined;
      const email   = (record.email as string) || "";
      const isTest  = record.is_test === true;

      if (!userId) {
        return new Response(
          JSON.stringify({ error: "Missing required field: record.id" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (isTest || isExcludedEmail(email)) {
        console.log(`notify-admin-new-homeowner: skipping test/excluded account ${email}`);
        return new Response(
          JSON.stringify({ success: true, skipped: true, reason: "test_account" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { data: existing } = await sb
        .from("notifications")
        .select("id")
        .eq("user_id", userId)
        .eq("notification_type", NOTIF_TYPE_HOMEOWNER)
        .eq("channel", "email")
        .limit(1);

      if (existing && existing.length > 0) {
        console.log(`notify-admin-new-homeowner: already sent for user_id=${userId}`);
        return new Response(
          JSON.stringify({ success: true, skipped: true, reason: "already_notified" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const fullName = (record.full_name as string) || "(no name given)";
      const cityStateZip = [record.address_city, record.address_state, record.address_zip]
        .filter(Boolean)
        .join(", ") || "location not yet provided";
      const signupTs = record.created_at
        ? new Date(record.created_at as string).toLocaleString("en-US", { timeZone: "America/Chicago" })
        : new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
      const maskedEmail = maskEmail(email);

      const subject  = `[OtterQuote] New homeowner: ${maskedEmail} — ${cityStateZip}`;
      const textBody = [
        `A new homeowner signed up on Otter Quotes.`,
        `Name     : ${fullName}`,
        `Email    : ${maskedEmail}`,
        `Signed up: ${signupTs} CT`,
        `Location : ${cityStateZip}`,
        ``,
        `Open the admin dashboard:`,
        ADMIN_PORTAL_URL,
      ].join("\n");
      const htmlBody = buildEmailHtml("New Homeowner Signup", [
        ["Name", escapeHtml(fullName)],
        ["Email", escapeHtml(maskedEmail)],
        ["Signed up", `${escapeHtml(signupTs)} CT`],
        ["Location", escapeHtml(cityStateZip)],
      ]);

      const mgData = await sendMail(mailgunDomain, mailgunKey, subject, textBody, htmlBody);

      await sb.from("notifications").insert({
        user_id:           userId,
        claim_id:          null,
        channel:           "email",
        notification_type: NOTIF_TYPE_HOMEOWNER,
        recipient:         ADMIN_EMAIL,
        message_preview:   `New homeowner signup: ${maskedEmail}`,
        sent_at:           new Date().toISOString(),
        delivered:         true,
        mailgun_id:        mgData.id,
      }).then(({ error }) => {
        if (error) console.warn(`notify-admin-new-homeowner: failed to log notification for user_id=${userId}:`, error);
      });

      return new Response(
        JSON.stringify({ success: true, mailgun_id: mgData.id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // eventType === "claim_created"
    const claimId = record.id as string | undefined;
    const userId  = record.user_id as string | undefined;
    if (!claimId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: record.id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // claims rows carry is_test but not email — resolve the owning profile
    // for the exclusion filter, the masked email in the subject, and a
    // name fallback (gh-1932 rework: claims.homeowner_name is preferred
    // when present, profiles.full_name is the fallback — at claim-creation
    // time one of the two is normally populated, unlike at bare signup).
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
