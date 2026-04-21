/**
 * OtterQuote Edge Function: notify-partner-w9
 *
 * Sends a W-9 request email to a referral partner whose commission payment
 * has been blocked pending W-9 submission (D-172).
 *
 * Called internally by the apply_referral_commission() PostgreSQL trigger
 * via net.http_post (pg_net) — NOT called by browser clients.
 *
 * The trigger already stamps w9_notification_sent_at before calling this
 * function, so duplicate sends are impossible even if the function errors
 * and retries.
 *
 * Auth model: accepts the Supabase service role key as bearer token.
 * No user JWT (caller is a database trigger, not a browser).
 * Uses a service-role Supabase client to look up the agent by ID.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *
 * D-172 / ClickUp: 86e0zrnbh (Mailgun email template)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PARTNER_DASHBOARD_URL = "https://otterquote.com/partner-dashboard.html#w9Upload";

// CORS — origin-allowlisted per project standard (Session 254).
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

// =============================================================================
// EMAIL HELPERS — mirrors notify-contractors pattern (Session 180)
// =============================================================================

function emailFooter(): string {
  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
      &nbsp;&nbsp;|&nbsp;&nbsp;
      <a href="tel:+18448753412" style="color:#0EA5E9;text-decoration:none;">(844) 875-3412</a>
    </td>
  </tr>
</table>`.trim();
}

function ctaButton(text: string, url: string, color = "#14B8A6"): string {
  return `
<table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="${color}" style="border-radius:8px;">
      <a href="${url}" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">${text}</a>
    </td>
  </tr>
</table>`.trim();
}

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
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">OtterQuote</span>
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

function w9RequestEmailHtml(firstName: string): string {
  const greeting = firstName ? `Hi ${firstName},` : "Hi there,";

  const body = `
    <p style="margin:0 0 6px;color:#64748B;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Action Required</p>
    <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Submit your W-9 to receive your referral payment</h2>

    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">${greeting}</p>

    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Your referral generated a commission payment, but we&rsquo;re unable to issue it yet. <strong>A completed IRS Form W-9 is required before any payment can be released.</strong></p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;margin:16px 0 24px;">
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 6px;color:#92400E;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">Why is this required?</p>
          <p style="margin:0;color:#78350F;font-size:14px;line-height:1.6;">The IRS requires OtterQuote to collect a W-9 from any partner who receives $600 or more in referral payments during a calendar year. We&rsquo;re required to issue a 1099-MISC for qualifying payments, and we cannot do so without your taxpayer information on file.</p>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 8px;color:#374151;font-size:15px;font-weight:600;">To release your payment:</p>
    <ol style="margin:0 0 24px;padding-left:20px;color:#374151;font-size:15px;line-height:1.8;">
      <li>Log in to your partner dashboard</li>
      <li>Find the &ldquo;W-9 Form&rdquo; card and click <strong>Upload W-9</strong></li>
      <li>Upload a signed, completed IRS Form W-9 (PDF)</li>
    </ol>

    <p style="margin:0 0 4px;color:#374151;font-size:14px;">Once received, our team will process your W-9 and release your payment promptly.</p>

    ${ctaButton("Upload My W-9 &rarr;", PARTNER_DASHBOARD_URL)}

    <p style="margin:16px 0 0;color:#64748B;font-size:13px;line-height:1.6;">Need a blank W-9 form? <a href="https://www.irs.gov/pub/irs-pdf/fw9.pdf" style="color:#0EA5E9;text-decoration:none;">Download from the IRS website &rarr;</a></p>
    <p style="margin:8px 0 0;color:#64748B;font-size:13px;line-height:1.6;">Questions? Reply to this email or contact us at <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>.</p>
  `;

  return buildEmail(body);
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Auth check ───────────────────────────────────────────────────────────
    // This function is called by a PostgreSQL trigger via pg_net using the
    // service role key. Verify the bearer token is the service role key.
    const authHeader = req.headers.get("Authorization") || "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    if (!bearerToken || bearerToken !== serviceRoleKey) {
      console.error("notify-partner-w9: unauthorized call (bearer mismatch)");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Parse payload ────────────────────────────────────────────────────────
    const body = await req.json().catch(() => null);
    const agentId = body?.agent_id as string | undefined;

    if (!agentId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: agent_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Load agent details ───────────────────────────────────────────────────
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: agent, error: agentErr } = await sb
      .from("referral_agents")
      .select("id, name, email, payments_blocked, w9_notification_sent_at")
      .eq("id", agentId)
      .single();

    if (agentErr || !agent) {
      console.error("notify-partner-w9: agent not found", agentId, agentErr);
      return new Response(
        JSON.stringify({ error: "Agent not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!agent.email) {
      console.error("notify-partner-w9: agent has no email", agentId);
      return new Response(
        JSON.stringify({ error: "Agent has no email address on file" }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Build and send Mailgun email ─────────────────────────────────────────
    const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
    const MAILGUN_DOMAIN  = Deno.env.get("MAILGUN_DOMAIN");

    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      throw new Error("Mailgun credentials not configured");
    }

    // Extract first name from full name (e.g. "Jane Smith" → "Jane")
    const firstName = (agent.name || "").split(" ")[0].trim();

    const htmlBody = w9RequestEmailHtml(firstName);
    const plainText = `Hi ${firstName || "there"},\n\nYour referral generated a commission payment, but we need a completed W-9 before we can release it.\n\nPlease log in to your partner dashboard to upload your W-9:\n${PARTNER_DASHBOARD_URL}\n\nQuestions? Email support@otterquote.com or call (844) 875-3412.\n\nOtterQuote Team`;

    const formData = new URLSearchParams();
    formData.append("from",    `OtterQuote <notifications@${MAILGUN_DOMAIN}>`);
    formData.append("to",      agent.email);
    formData.append("subject", "Action required \u2014 submit your W-9 to receive your OtterQuote referral payment");
    formData.append("text",    plainText);
    formData.append("html",    htmlBody);

    const mgRes = await fetch(
      `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`api:${MAILGUN_API_KEY}`)}` },
        body: formData,
      }
    );

    if (!mgRes.ok) {
      const errText = await mgRes.text();
      console.error("notify-partner-w9: Mailgun error", mgRes.status, errText);
      throw new Error(`Mailgun API error (HTTP ${mgRes.status}): ${errText}`);
    }

    const mgResult = await mgRes.json();
    console.log(`notify-partner-w9: W-9 request sent to agent_id=${agentId} email=${agent.email} mailgun_id=${mgResult.id}`);

    return new Response(
      JSON.stringify({ success: true, mailgun_id: mgResult.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("notify-partner-w9 error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
