/**
 * OtterQuote Edge Function: notify-payout-pending
 *
 * D-180 — Immediate Payout Approval Request Email
 *
 * Called when a new payout_approvals row is created (status='pending_approval').
 * Invoked by the apply_referral_commission() trigger via pg_net.http_post(),
 * or can be called manually/from process-payout-reminders for catch-up runs.
 *
 * Auth: No JWT required (invoked by service role from the DB trigger).
 *   The function accepts a service-role Authorization header and validates
 *   the payout_approval_id exists before sending. Input is treated as
 *   untrusted; only reads DB data to build the email body.
 *
 * Rate limiting: checked against rate_limit_config 'notify-payout-pending'.
 *
 * Idempotency: Sets notification_sent_at = NOW() on the row after sending.
 *   Subsequent calls for the same payout_approval_id are no-ops if
 *   notification_sent_at IS NOT NULL.
 *
 * Input: POST { payout_approval_id: string (UUID) }
 * Output: { ok: true, sent: boolean, reason?: string }
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *
 * ClickUp: 86e1161bk
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "notify-payout-pending";
const ADMIN_EMAIL   = "dustinstohler1@gmail.com";
const ADMIN_PAYOUTS_URL = "https://otterquote.com/admin-payouts.html";

// CORS: allowlisted (admin + internal use only).
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
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

// =============================================================================
// EMAIL HELPERS
// =============================================================================

function emailFooter(): string {
  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
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
      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                         font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">
              Otter Quotes
            </span>
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

function ctaButton(text: string, url: string, color = "#E07B00"): string {
  return `
<table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="${color}" style="border-radius:8px;">
      <a href="${url}" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         font-size:16px;font-weight:700;color:#0B1929;text-decoration:none;padding:14px 28px;">
        ${text}
      </a>
    </td>
  </tr>
</table>`.trim();
}

function formatCurrency(amount: number): string {
  return `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPayoutType(type: string): string {
  return type === "commission_referral" ? "Referral Commission" : "Recruit Bonus";
}

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
    const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: { Authorization: `Basic ${basicAuth}` },
      body: formData,
    });
    if (!response.ok) {
      const err = await response.text();
      console.error(`[${FUNCTION_NAME}] Mailgun error (${response.status}):`, err);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Mailgun fetch threw:`, err);
    return false;
  }
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl     = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const mailgunApiKey   = Deno.env.get("MAILGUN_API_KEY")!;
  const mailgunDomain   = Deno.env.get("MAILGUN_DOMAIN")!;

  if (!supabaseUrl || !serviceRoleKey || !mailgunApiKey || !mailgunDomain) {
    console.error(`[${FUNCTION_NAME}] Missing required env vars.`);
    return new Response(JSON.stringify({ ok: false, error: "Server configuration error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Use service role client — this function is called from the DB trigger.
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    // ── Rate limiting ────────────────────────────────────────────────────────
    const { data: rlData, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_caller_id: null,
    });
    if (rlError) {
      console.error(`[${FUNCTION_NAME}] Rate limit RPC error:`, rlError.message);
    } else if (!rlData) {
      console.warn(`[${FUNCTION_NAME}] Rate limit exceeded — skipping.`);
      return new Response(JSON.stringify({ ok: false, error: "Rate limit exceeded" }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Parse input ──────────────────────────────────────────────────────────
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch (_) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON body" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payoutApprovalId = (body.payout_approval_id as string || "").trim();
    if (!payoutApprovalId) {
      return new Response(JSON.stringify({ ok: false, error: "payout_approval_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Load the approval row ────────────────────────────────────────────────
    const { data: approval, error: approvalError } = await supabase
      .from("payout_approvals")
      .select("*")
      .eq("id", payoutApprovalId)
      .single();

    if (approvalError || !approval) {
      console.error(`[${FUNCTION_NAME}] Approval not found:`, payoutApprovalId, approvalError?.message);
      return new Response(JSON.stringify({ ok: false, error: "Approval not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Idempotency check ────────────────────────────────────────────────────
    if (approval.notification_sent_at) {
      console.log(`[${FUNCTION_NAME}] Notification already sent for ${payoutApprovalId} — skipping.`);
      return new Response(JSON.stringify({ ok: true, sent: false, reason: "Already notified" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Build and send email to Dustin ───────────────────────────────────────
    const partnerName   = approval.partner_name || "Unknown Partner";
    const amount        = formatCurrency(Number(approval.amount));
    const payoutType    = formatPayoutType(approval.payout_type);
    const autoApproveOn = approval.auto_approve_at
      ? new Date(approval.auto_approve_at).toLocaleDateString("en-US", {
          month: "long", day: "numeric", year: "numeric",
        })
      : "N/A";
    const triggerEvent  = approval.trigger_event || "Commission qualifying event";

    const subject = `Commission pending your approval — ${partnerName} — ${amount}`;

    const bodyHtml = `
<h2 style="font-size:1.5rem;font-weight:700;color:#0B1929;margin:0 0 8px;">
  Action Required: Commission Approval
</h2>
<p style="color:#64748B;font-size:0.9rem;margin:0 0 24px;">
  A commission is pending your review and approval.
</p>

<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#F8FAFC;border-radius:8px;border:1px solid #E2E8F0;margin-bottom:24px;">
  <tr>
    <td style="padding:20px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:6px 0;font-size:0.875rem;color:#64748B;width:160px;">Partner Name</td>
          <td style="padding:6px 0;font-size:0.875rem;font-weight:600;color:#0B1929;">${partnerName}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:0.875rem;color:#64748B;">Commission Type</td>
          <td style="padding:6px 0;font-size:0.875rem;font-weight:600;color:#0B1929;">${payoutType}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:0.875rem;color:#64748B;">Amount</td>
          <td style="padding:6px 0;font-size:1.25rem;font-weight:700;color:#0B1929;">${amount}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:0.875rem;color:#64748B;">Trigger Event</td>
          <td style="padding:6px 0;font-size:0.875rem;color:#0B1929;">${triggerEvent}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:0.875rem;color:#64748B;">Auto-Approves</td>
          <td style="padding:6px 0;font-size:0.875rem;color:#0B1929;">${autoApproveOn} if no action taken</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:0.875rem;color:#64748B;">Approval ID</td>
          <td style="padding:6px 0;font-size:0.75rem;color:#94A3B8;font-family:monospace;">${payoutApprovalId}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>

${ctaButton("Review in Admin →", ADMIN_PAYOUTS_URL)}

<p style="font-size:0.8rem;color:#94A3B8;margin-top:16px;">
  You have until ${autoApproveOn} to approve or reject this commission. After that, it will auto-approve automatically.
</p>
`;

    const bodyText = [
      `Action Required: Commission Approval`,
      ``,
      `Partner: ${partnerName}`,
      `Type: ${payoutType}`,
      `Amount: ${amount}`,
      `Trigger: ${triggerEvent}`,
      `Auto-Approves: ${autoApproveOn}`,
      ``,
      `Review here: ${ADMIN_PAYOUTS_URL}`,
    ].join("\n");

    const fromAddress = `Otter Quotes Admin <notifications@${mailgunDomain}>`;
    const sent = await sendMailgunEmail(
      mailgunApiKey,
      mailgunDomain,
      ADMIN_EMAIL,
      fromAddress,
      subject,
      bodyText,
      buildEmail(bodyHtml)
    );

    // ── Mark notification_sent_at ────────────────────────────────────────────
    if (sent) {
      const { error: updateError } = await supabase
        .from("payout_approvals")
        .update({ notification_sent_at: new Date().toISOString() })
        .eq("id", payoutApprovalId);

      if (updateError) {
        console.error(`[${FUNCTION_NAME}] Failed to set notification_sent_at:`, updateError.message);
      }
    }

    console.log(`[${FUNCTION_NAME}] Notification ${sent ? "sent" : "FAILED"} for approval ${payoutApprovalId} — ${partnerName} ${amount}`);

    return new Response(JSON.stringify({ ok: true, sent }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Unhandled error:`, err);
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
