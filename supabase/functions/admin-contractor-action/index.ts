/**
 * Otter Quotes Edge Function: admin-contractor-action
 *
 * Handles admin actions on contractor accounts:
 *   - approve: Activate contractor and send welcome email
 *   - reject: Mark as inactive and send rejection email
 *   - send_insurance_verification: Send COI verification request to broker
 *   - mark_license_verified: Mark license as verified
 *   - mark_insurance_verified: Mark insurance as verified
 *   - save_notes: Save admin notes to contractor record
 *
 * All actions require authentication as dustinstohler1@gmail.com.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS tightened Apr 15, 2026 (Session 181, ClickUp 86e0xhz2j): admin-only
// function (requires dustinstohler1@gmail.com auth) — origin allowlisted.
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
// EMAIL HELPERS
// =============================================================================

const DASHBOARD_URL = "https://otterquote.com/contractor-dashboard.html";
const SETTINGS_URL = "https://otterquote.com/contractor-settings.html";

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

function buildEmail(bodyHtml: string): string {
  return `<!DOCTYPE html>
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
            ${bodyHtml}
          </td>
        </tr>
        <tr><td>${emailFooter()}</td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

/** Send a Mailgun email. Returns true on success. Accepts optional html (text is plain-text fallback). */
async function sendMailgunEmail(
  apiKey: string,
  domain: string,
  to: string,
  from: string,
  subject: string,
  text: string,
  html?: string
): Promise<boolean> {
  const basicAuth = btoa(`api:${apiKey}`);
  const formData = new URLSearchParams();
  formData.append("from", from);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", text);
  if (html) formData.append("html", html);

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
      console.error(`Mailgun error (${response.status}):`, errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Mailgun request failed:", err);
    return false;
  }
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Health check ping -- returns immediately without doing real work.
  // The platform-health-check function uses a service-role bearer token,
  // so we check for health_check before the admin JWT gate.
  try {
    const bodyPeek = await req.clone().json().catch(() => ({}));
    if (bodyPeek?.health_check === true) {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }
  } catch { /* no-op */ }

  try {
    // Get the JWT from Authorization header
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.substring(7);

    // Initialize Supabase clients
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase credentials not configured");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify user is admin
    const { data: user, error: userError } = await supabase.auth.getUser(
      token
    );

    if (userError || !user?.user || user.user.email !== "dustinstohler1@gmail.com") {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse request body
    const body = await req.json();
    const { action, contractor_id, reason, broker_email, contractor_company_name, notes } = body;

    if (!action || !contractor_id) {
      return new Response(
        JSON.stringify({ error: "Missing action or contractor_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const mailgunKey = Deno.env.get("MAILGUN_API_KEY");
    const mailgunDomain = Deno.env.get("MAILGUN_DOMAIN");

    if (!mailgunKey || !mailgunDomain) {
      throw new Error("Mailgun credentials not configured");
    }

    // ── Action: approve ──
    if (action === "approve") {
      // Update contractor status
      const { error: updateError } = await supabase
        .from("contractors")
        .update({
          status: "active",
          approved_at: new Date().toISOString(),
        })
        .eq("id", contractor_id);

      if (updateError) {
        throw updateError;
      }

      // Fetch contractor details (include contact_name for personal greeting)
      const { data: contractor } = await supabase
        .from("contractors")
        .select("email, company_name, contact_name")
        .eq("id", contractor_id)
        .single();

      if (contractor) {
        const greeting = contractor.contact_name || contractor.company_name || "there";

        const approvalEmailText = `Hi ${greeting},

Great news — your Otter Quotes contractor account has been approved. You can now browse available opportunities and submit bids.

Log in to get started: ${DASHBOARD_URL}

Before submitting your first bid, complete these steps in your Getting Started checklist:
- Add a payment method (required to receive projects)
- Upload your contract template
- Select your preferred shingle brand

Tip: Enable Auto-Bid in Settings to automatically compete for every matching opportunity — no action needed between jobs.

Questions? support@otterquote.com | (844) 875-3412

The Otter Quotes Team`;

        const approvalEmailHtml = buildEmail(`
          <p style="margin:0 0 6px;color:#14B8A6;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">You're Approved</p>
          <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Welcome to Otter Quotes, ${greeting}!</h2>

          <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">Your account is active. You can now browse available opportunities and submit bids.</p>

          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;margin-bottom:24px;">
            <tr><td style="padding:16px 20px;">
              <p style="margin:0 0 10px;color:#166534;font-size:14px;font-weight:700;">Complete these steps before your first bid:</p>
              <table cellpadding="0" cellspacing="0" border="0">
                <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">1.&nbsp; Add a payment method (required to receive projects)</td></tr>
                <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">2.&nbsp; Upload your contract template</td></tr>
                <tr><td style="padding:3px 0;color:#15803D;font-size:14px;">3.&nbsp; Select your preferred shingle brand</td></tr>
              </table>
            </td></tr>
          </table>

          <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
            <tr>
              <td align="center" bgcolor="#14B8A6" style="border-radius:8px;">
                <a href="${DASHBOARD_URL}" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">Go to My Dashboard &rarr;</a>
              </td>
            </tr>
          </table>

          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;">
            <tr>
              <td style="padding:14px 16px;">
                <p style="margin:0 0 4px;color:#92400E;font-size:14px;font-weight:600;">&#9889; Enable Auto-Bid</p>
                <p style="margin:0;color:#78350F;font-size:13px;line-height:1.5;">Auto-Bid places you in the running for every matching opportunity automatically &mdash; no action needed between jobs. Set it up in <a href="${SETTINGS_URL}" style="color:#92400E;">Settings</a>.</p>
              </td>
            </tr>
          </table>
        `);

        await sendMailgunEmail(
          mailgunKey,
          mailgunDomain,
          contractor.email,
          "Otter Quotes <notifications@mail.otterquote.com>",
          "Welcome to Otter Quotes — You're Approved!",
          approvalEmailText,
          approvalEmailHtml
        );
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Action: reject ──
    if (action === "reject") {
      if (!reason) {
        return new Response(
          JSON.stringify({ error: "Missing rejection reason" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Update contractor status
      const { error: updateError } = await supabase
        .from("contractors")
        .update({
          status: "inactive",
          rejected_at: new Date().toISOString(),
          rejection_reason: reason,
        })
        .eq("id", contractor_id);

      if (updateError) {
        throw updateError;
      }

      // Fetch contractor details
      const { data: contractor } = await supabase
        .from("contractors")
        .select("email, company_name, contact_name")
        .eq("id", contractor_id)
        .single();

      if (contractor) {
        const greeting = contractor.contact_name || contractor.company_name || "there";
        const rejectionEmailText = `Hi ${greeting},

Thank you for applying to join the Otter Quotes contractor network. After reviewing your application, we weren't able to approve your account at this time.

Reason: ${reason}

If you'd like to address this and reapply, please contact us at support@otterquote.com or call (844) 875-3412. We're happy to work with you to get things squared away.

The Otter Quotes Team`;

        await sendMailgunEmail(
          mailgunKey,
          mailgunDomain,
          contractor.email,
          "Otter Quotes <notifications@mail.otterquote.com>",
          "Otter Quotes Application — Update on Your Account",
          rejectionEmailText
        );
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Action: send_insurance_verification ──
    if (action === "send_insurance_verification") {
      if (!broker_email || !contractor_company_name) {
        return new Response(
          JSON.stringify({ error: "Missing broker_email or contractor_company_name" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Update contractor
      const { error: updateError } = await supabase
        .from("contractors")
        .update({
          insurance_verification_sent_at: new Date().toISOString(),
          insurance_verification_email: broker_email,
        })
        .eq("id", contractor_id);

      if (updateError) {
        throw updateError;
      }

      const coiEmail = `Dear Insurance Representative,

We are writing to verify the Certificate of Insurance on file for ${contractor_company_name}, who has applied to join the Otter Quotes contractor network.

We are requesting confirmation that the following policies are currently active and in good standing for this insured:
- Commercial General Liability Insurance
- Workers' Compensation Insurance

Please reply to this email confirming policy status, or contact us at info@otterquote.com or (844) 875-3412 with any questions.

Thank you for your time.

Otter Quotes
info@otterquote.com
(844) 875-3412
https://otterquote.com`;

      await sendMailgunEmail(
        mailgunKey,
        mailgunDomain,
        broker_email,
        "Otter Quotes <info@mail.otterquote.com>",
        "COI Verification Request — Otter Quotes",
        coiEmail
      );

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Action: mark_license_verified ──
    if (action === "mark_license_verified") {
      const { error: updateError } = await supabase
        .from("contractors")
        .update({
          license_verified: true,
          license_verified_at: new Date().toISOString(),
        })
        .eq("id", contractor_id);

      if (updateError) {
        throw updateError;
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Action: mark_insurance_verified ──
    if (action === "mark_insurance_verified") {
      const { error: updateError } = await supabase
        .from("contractors")
        .update({
          insurance_verified: true,
          insurance_verified_at: new Date().toISOString(),
        })
        .eq("id", contractor_id);

      if (updateError) {
        throw updateError;
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Action: save_notes ──
    if (action === "save_notes") {
      const { error: updateError } = await supabase
        .from("contractors")
        .update({
          admin_notes: notes || null,
        })
        .eq("id", contractor_id);

      if (updateError) {
        throw updateError;
      }

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Unknown action
    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("admin-contractor-action error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
