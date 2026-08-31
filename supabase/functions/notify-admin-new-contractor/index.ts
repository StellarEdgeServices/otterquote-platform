/**
 * OtterQuote Edge Function: notify-admin-new-contractor
 *
 * Sends an admin notification email to Dustin whenever a contractor signs up
 * and enters pending_approval status.
 *
 * Triggered by a PostgreSQL trigger (trg_notify_admin_new_contractor) via
 * pg_net on INSERT or UPDATE to contractors where status = 'pending_approval'.
 * NOT called by browser clients.
 *
 * Auth model: accepts the Supabase service role key as bearer token.
 * Idempotency: checks notifications table before sending — skips if
 * admin_new_contractor notification already sent for this contractor.
 *
 * Test account filter: skips emails matching:
 *   %otterquote-internal.test%  |  %pfw-%  |  %authdoctor%
 *
 * Environment variables (all already set in Supabase secrets):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *
 * ClickUp: 86e1nr89h
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_EMAIL        = "dustinstohler1@gmail.com";
const ADMIN_PORTAL_URL   = "https://otterquote.com/admin-contractors.html";
const NOTIFICATION_TYPE  = "admin_new_contractor";

// CORS — origin-allowlisted per project standard (Session 254).
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

function isTestAccount(email: string): boolean {
  const lower = email.toLowerCase();
  return (
    lower.includes("otterquote-internal.test") ||
    lower.includes("pfw-") ||
    lower.includes("authdoctor")
  );
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmailHtml(
  companyName: string,
  contactName: string,
  email: string,
  signupTs: string,
): string {
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
        <!-- Header -->
        <tr>
          <td style="background:#0B1929;padding:20px 24px;">
            <h2 style="color:#F59E0B;margin:0;font-size:1.1rem;font-family:sans-serif;">
              🦦 New Contractor Signup — Review Required
            </h2>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:24px;font-family:sans-serif;color:#0B1929;">
            <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
              A new contractor has signed up and is awaiting approval.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="border-collapse:collapse;font-size:14px;margin-bottom:24px;">
              <tr>
                <td style="padding:8px 0;color:#64748B;width:130px;vertical-align:top;">Company</td>
                <td style="padding:8px 0;font-weight:600;">${escapeHtml(companyName)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Contact</td>
                <td style="padding:8px 0;">${escapeHtml(contactName)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Email</td>
                <td style="padding:8px 0;">
                  <a href="mailto:${escapeHtml(email)}" style="color:#0369A1;">${escapeHtml(email)}</a>
                </td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748B;vertical-align:top;">Signed up</td>
                <td style="padding:8px 0;">${escapeHtml(signupTs)} CT</td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#F59E0B" style="border-radius:8px;">
                  <a href="${ADMIN_PORTAL_URL}"
                     style="display:inline-block;font-family:sans-serif;font-size:15px;font-weight:700;
                            color:#0B1929;text-decoration:none;padding:12px 24px;">
                    Review in Admin Portal &rarr;
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Footer -->
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

// =============================================================================
// MAIN HANDLER
// =============================================================================

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const supabaseUrl    = Deno.env.get("SUPABASE_URL") || "";
    const mailgunKey     = Deno.env.get("MAILGUN_API_KEY") || "";
    const mailgunDomain  = Deno.env.get("MAILGUN_DOMAIN") || "";

    if (!serviceRoleKey || !supabaseUrl || !mailgunKey || !mailgunDomain) {
      throw new Error("Missing required environment variables");
    }

    const authHeader  = req.headers.get("Authorization") || "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!bearerToken || bearerToken !== serviceRoleKey) {
      console.error("notify-admin-new-contractor: unauthorized");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => null);
    const contractorId = body?.contractor_id as string | undefined;
    if (!contractorId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: contractor_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: contractor, error: cErr } = await sb
      .from("contractors")
      .select("id, user_id, company_name, contact_name, email, status, created_at")
      .eq("id", contractorId)
      .single();

    if (cErr || !contractor) {
      console.error("notify-admin-new-contractor: contractor not found", contractorId, cErr);
      return new Response(
        JSON.stringify({ error: "Contractor not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const email = contractor.email || "";
    if (isTestAccount(email)) {
      console.log(`notify-admin-new-contractor: skipping test account ${email}`);
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "test_account" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: existing } = await sb
      .from("notifications")
      .select("id")
      .eq("user_id", contractor.user_id)
      .eq("notification_type", NOTIFICATION_TYPE)
      .eq("channel", "email")
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`notify-admin-new-contractor: already sent for contractor_id=${contractorId}`);
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "already_notified" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const companyName  = contractor.company_name || "(unnamed company)";
    const contactName  = contractor.contact_name || "(no contact name)";
    const signupTs     = contractor.created_at
      ? new Date(contractor.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" })
      : new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });

    const subject  = `🦦 New Contractor Signup — ${companyName} (pending review)`;
    const textBody = [
      `New contractor signup on Otter Quotes — review required.`,
      ``,
      `Company  : ${companyName}`,
      `Contact  : ${contactName}`,
      `Email    : ${email}`,
      `Signed up: ${signupTs} CT`,
      ``,
      `Review in admin portal:`,
      ADMIN_PORTAL_URL,
    ].join("\n");

    const htmlBody = buildEmailHtml(companyName, contactName, email, signupTs);

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

    const mgData = await mgRes.json();
    console.log(`notify-admin-new-contractor: sent for contractor_id=${contractorId} mailgun_id=${mgData.id}`);

    const { error: insertErr } = await sb.from("notifications").insert({
      user_id:          contractor.user_id,
      claim_id:         null,
      channel:          "email",
      notification_type: NOTIFICATION_TYPE,
      recipient:        ADMIN_EMAIL,
      message_preview:  `New contractor signup: ${companyName} (${email})`,
      sent_at:          new Date().toISOString(),
      delivered:        true,
      mailgun_id:       mgData.id,
    });

    if (insertErr) {
      // Non-fatal — email already sent, just log the warning
      console.warn(`notify-admin-new-contractor: failed to log notification for contractor_id=${contractorId}:`, insertErr);
    }

    return new Response(
      JSON.stringify({ success: true, mailgun_id: mgData.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (err) {
    console.error("notify-admin-new-contractor error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
