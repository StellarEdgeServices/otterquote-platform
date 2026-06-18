/**
 * OtterQuote Edge Function: send-welcome-email
 *
 * D-220 Phase 16 Unit 1b (Option A): server-side contractor welcome email.
 *
 * Replaces the former browser → send-support-email "direct send" path, which
 * was an unauthenticated open relay (arbitrary recipient + arbitrary HTML from
 * our Mailgun domain). The welcome template now lives here and is sent only to
 * the contractor's own server-derived address after a verified-JWT ownership
 * check.
 *
 * Auth: verify_jwt = true (config.toml). The handler ALSO re-validates the
 * Bearer token via auth.getUser and requires the caller to own the contractor
 * record (contractor.user_id === user.id) — defense in depth + ownership gate.
 *
 * Input:  { contractor_id }
 * Output: { status: "sent", id } | { error }
 *
 * Environment variables (already set in Supabase secrets / injected by runtime):
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *   SUPABASE_URL              (auto-injected by Supabase runtime)
 *   SUPABASE_SERVICE_ROLE_KEY (auto-injected by Supabase runtime)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAILGUN_TIMEOUT_MS = 10_000; // 10s — defensive; Mailgun can be slow on cold calls

// CORS — mirrors create-hubspot-contact's origin allow-list.
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Escape user-supplied strings before interpolating into HTML email templates. */
function escapeHtml(str: string): string {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, corsHeaders);
  }

  // ── Auth: require a verified Bearer JWT (also enforced at the gateway) ──────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Unauthorized" }, 401, corsHeaders);
  }
  const token = authHeader.slice(7);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const sb = createClient(supabaseUrl, serviceRoleKey);

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) {
    return json({ error: "Unauthorized" }, 401, corsHeaders);
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  let contractor_id: string;
  try {
    const body = await req.json();
    contractor_id = body.contractor_id;
  } catch {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders);
  }
  if (!contractor_id) {
    return json({ error: "Missing required field: contractor_id" }, 400, corsHeaders);
  }

  // ── Load contractor (service-role; recipient is server-derived) ─────────────
  const { data: contractor, error: contractorErr } = await sb
    .from("contractors")
    .select("id, user_id, email, company_name")
    .eq("id", contractor_id)
    .single();

  if (contractorErr || !contractor) {
    return json({ error: "Contractor not found" }, 404, corsHeaders);
  }

  // Ownership gate: the caller must own this contractor record.
  if (contractor.user_id !== user.id) {
    return json({ error: "Forbidden" }, 403, corsHeaders);
  }

  // Recipient is derived server-side — never accepted from the request body.
  const recipient = contractor.email || user.email;
  if (!recipient) {
    return json({ error: "No recipient address on file" }, 422, corsHeaders);
  }

  const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
  const MAILGUN_DOMAIN = Deno.env.get("MAILGUN_DOMAIN");
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    console.error("send-welcome-email: Mailgun credentials not configured.");
    return json({ error: "Mailgun credentials not configured." }, 500, corsHeaders);
  }

  // ── Build the welcome email server-side (ported verbatim from js/auth.js) ───
  const greeting = contractor.company_name || "there";
  const settingsUrl = "https://otterquote.com/contractor-settings.html";
  const subject = "Welcome to Otter Quotes — Your Application Is In Review";

  const welcomeMessage = `Hi ${greeting},

Welcome to Otter Quotes — your application is now in review.

Our team typically completes reviews within 2–5 business days. Here's what we check during that time:
- Contractor license verification
- Certificate of Insurance (COI) requirements
- Overall profile completeness

While you wait, use the time to get everything ready so you can hit the ground running the moment you're approved.

What to prepare:
1. Valid CGL Certificate of Insurance — $1M per occurrence / $2M aggregate, with Stellar Edge Services LLC listed as additional insured
2. Contractor license information for each trade and municipality you work in
3. Contract template (PDF) for each trade you offer
4. Stripe payment method — required before you can receive projects

Complete your profile now:
${settingsUrl}

Questions? support@otterquote.com | (844) 875-3412

The Otter Quotes Team
https://otterquote.com`;

  const welcomeHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Otter Quotes</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            <p style="margin:0 0 6px;color:#14B8A6;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Application In Review</p>
            <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Welcome to Otter Quotes, ${escapeHtml(greeting)}!</h2>
            <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">Your application is in review. Our team typically completes the process within <strong>2&ndash;5 business days</strong>. Here&rsquo;s what we check:</p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8FAFC;border-radius:8px;margin-bottom:24px;">
              <tr><td style="padding:16px 20px;border-bottom:1px solid #E2E8F0;">
                <table cellpadding="0" cellspacing="0" border="0"><tr>
                  <td style="width:28px;vertical-align:top;padding-top:2px;">
                    <div style="width:22px;height:22px;background:#14B8A6;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#ffffff;">1</div>
                  </td>
                  <td style="padding-left:12px;">
                    <p style="margin:0;color:#0F172A;font-size:14px;font-weight:600;">License Verification</p>
                    <p style="margin:4px 0 0;color:#64748B;font-size:13px;">We verify your contractor license(s) for each trade and municipality.</p>
                  </td>
                </tr></table>
              </td></tr>
              <tr><td style="padding:16px 20px;border-bottom:1px solid #E2E8F0;">
                <table cellpadding="0" cellspacing="0" border="0"><tr>
                  <td style="width:28px;vertical-align:top;padding-top:2px;">
                    <div style="width:22px;height:22px;background:#14B8A6;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#ffffff;">2</div>
                  </td>
                  <td style="padding-left:12px;">
                    <p style="margin:0;color:#0F172A;font-size:14px;font-weight:600;">COI Requirements</p>
                    <p style="margin:4px 0 0;color:#64748B;font-size:13px;">We confirm your Certificate of Insurance meets our coverage minimums ($1M/$2M CGL, Stellar Edge Services LLC as additional insured).</p>
                  </td>
                </tr></table>
              </td></tr>
              <tr><td style="padding:16px 20px;">
                <table cellpadding="0" cellspacing="0" border="0"><tr>
                  <td style="width:28px;vertical-align:top;padding-top:2px;">
                    <div style="width:22px;height:22px;background:#14B8A6;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#ffffff;">3</div>
                  </td>
                  <td style="padding-left:12px;">
                    <p style="margin:0;color:#0F172A;font-size:14px;font-weight:600;">Profile Check</p>
                    <p style="margin:4px 0 0;color:#64748B;font-size:13px;">We review your profile for completeness before activating your account.</p>
                  </td>
                </tr></table>
              </td></tr>
            </table>
            <p style="margin:0 0 12px;color:#0F172A;font-size:15px;font-weight:700;">What to prepare while you wait:</p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0FDFA;border:1px solid #99F6E4;border-radius:8px;margin-bottom:24px;">
              <tr><td style="padding:16px 20px;">
                <table cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr><td style="padding:4px 0;color:#0F172A;font-size:14px;vertical-align:top;">
                    <span style="color:#14B8A6;font-weight:700;margin-right:8px;">&#10003;</span><strong>Valid CGL Certificate of Insurance</strong> &mdash; $1M per occurrence / $2M aggregate, with <em>Stellar Edge Services LLC</em> listed as additional insured
                  </td></tr>
                  <tr><td style="padding:4px 0;color:#0F172A;font-size:14px;vertical-align:top;">
                    <span style="color:#14B8A6;font-weight:700;margin-right:8px;">&#10003;</span><strong>Contractor license information</strong> for each trade and municipality you serve
                  </td></tr>
                  <tr><td style="padding:4px 0;color:#0F172A;font-size:14px;vertical-align:top;">
                    <span style="color:#14B8A6;font-weight:700;margin-right:8px;">&#10003;</span><strong>Contract template (PDF)</strong> for each trade you offer
                  </td></tr>
                  <tr><td style="padding:4px 0;color:#0F172A;font-size:14px;vertical-align:top;">
                    <span style="color:#14B8A6;font-weight:700;margin-right:8px;">&#10003;</span><strong>Stripe payment method</strong> &mdash; required before you can receive projects
                  </td></tr>
                </table>
              </td></tr>
            </table>
            <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Head to your profile settings to upload documents and connect your payment method before your review completes &mdash; it speeds things up.</p>
            <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:8px;">
              <tr>
                <td align="center" bgcolor="#14B8A6" style="border-radius:8px;">
                  <a href="${settingsUrl}" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">Complete Your Profile &rarr;</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
            <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <a href="tel:+18448753412" style="color:#0EA5E9;text-decoration:none;">(844) 875-3412</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  // ── Send via Mailgun (10s AbortController timeout) ──────────────────────────
  const formData = new URLSearchParams();
  formData.append("from", `Otter Quotes <notifications@${MAILGUN_DOMAIN}>`);
  formData.append("to", recipient);
  formData.append("subject", subject);
  formData.append("text", welcomeMessage);
  formData.append("html", welcomeHtml);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MAILGUN_TIMEOUT_MS);

  let mailgunResult: { id: string };
  try {
    const mailgunResponse = await fetch(
      `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`api:${MAILGUN_API_KEY}`)}`,
        },
        body: formData,
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);

    if (!mailgunResponse.ok) {
      const errorData = await mailgunResponse.text();
      console.error("send-welcome-email Mailgun error:", mailgunResponse.status, errorData);
      return json(
        { error: `Mailgun API error (HTTP ${mailgunResponse.status})` },
        502,
        corsHeaders
      );
    }
    mailgunResult = await mailgunResponse.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      console.error("send-welcome-email: Mailgun request timed out after 10 seconds.");
      return json({ error: "Mailgun request timed out after 10 seconds." }, 504, corsHeaders);
    }
    console.error("send-welcome-email: Mailgun request failed:", err);
    return json({ error: "Failed to send welcome email" }, 502, corsHeaders);
  }

  console.log("send-welcome-email sent. Mailgun ID:", mailgunResult.id, "To:", recipient);

  // ── Activity log (non-fatal: the email was already sent) ────────────────────
  try {
    const { error: logError } = await sb.from("activity_log").insert({
      user_id: contractor.user_id,
      event_type: "welcome_email_sent",
      title: `Welcome email sent to ${recipient}`,
      metadata: {
        contractor_id: contractor.id,
        message_id: mailgunResult.id,
      },
    });
    if (logError) {
      console.error("send-welcome-email: activity_log insert failed (non-fatal):", logError.message);
    }
  } catch (logErr) {
    console.error("send-welcome-email: activity_log insert exception (non-fatal):", logErr);
  }

  return json({ status: "sent", id: mailgunResult.id }, 200, corsHeaders);
});
