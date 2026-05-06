/**
 * OtterQuote Edge Function: approve-payout
 *
 * D-180 — Admin Commission Approval
 *
 * Approves a pending commission. Admin-only (JWT must be dustinstohler1@gmail.com).
 * On approval:
 *   1. Sets payout_approvals.status = 'approved', approved_at = NOW(), approved_by = 'admin'
 *   2. Sets referrals.commission_paid_at = NOW() on the associated referral
 *   3. Sends a Mailgun confirmation email to the partner
 *
 * Input: POST { payout_approval_id: string }
 * Output: { ok: true, approval_id: string }
 *
 * Auth: Requires valid Supabase JWT with email = dustinstohler1@gmail.com.
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN
 *
 * ClickUp: 86e1160fg
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME     = "approve-payout";
const ADMIN_EMAIL       = "dustinstohler1@gmail.com";
const PARTNER_DASH_URL  = "https://otterquote.com/partner-dashboard.html";

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

function ctaButton(text: string, url: string): string {
  return `
<table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="#10B981" style="border-radius:8px;">
      <a href="${url}" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">
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

  const supabaseUrl    = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnon   = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const mailgunApiKey  = Deno.env.get("MAILGUN_API_KEY")!;
  const mailgunDomain  = Deno.env.get("MAILGUN_DOMAIN")!;

  if (!supabaseUrl || !serviceRoleKey || !mailgunApiKey || !mailgunDomain) {
    return new Response(JSON.stringify({ ok: false, error: "Server configuration error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── JWT verification — admin only ────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, supabaseAnon || serviceRoleKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();

  if (userError || !userData?.user || userData.user.email !== ADMIN_EMAIL) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized — admin only" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Use service role for DB writes.
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    // ── Rate limiting ────────────────────────────────────────────────────────
    const { data: rlData, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_user_id: null,
    });
    if (rlError) {
      console.error(`[${FUNCTION_NAME}] Rate limit RPC error:`, rlError.message);
    } else if (!rlData) {
      return new Response(JSON.stringify({ ok: false, error: "Rate limit exceeded" }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Parse input ──────────────────────────────────────────────────────────
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch (_) {
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
      return new Response(JSON.stringify({ ok: false, error: "Approval not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Idempotency: only act on pending rows ────────────────────────────────
    if (!["pending_approval"].includes(approval.status)) {
      return new Response(JSON.stringify({
        ok: true,
        sent: false,
        reason: `Already in status '${approval.status}' — no action taken`,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date().toISOString();

    // ── Update payout_approvals ──────────────────────────────────────────────
    const { error: updateError } = await supabase
      .from("payout_approvals")
      .update({
        status:      "approved",
        approved_at: now,
        approved_by: "admin",
      })
      .eq("id", payoutApprovalId);

    if (updateError) {
      console.error(`[${FUNCTION_NAME}] Failed to update payout_approvals:`, updateError.message);
      return new Response(JSON.stringify({ ok: false, error: "Database update failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Set referrals.commission_paid_at ─────────────────────────────────────
    if (approval.referral_id) {
      const { error: referralError } = await supabase
        .from("referrals")
        .update({ commission_paid_at: now })
        .eq("id", approval.referral_id)
        .is("commission_paid_at", null); // Only set if not already paid

      if (referralError) {
        console.error(`[${FUNCTION_NAME}] Failed to update referral commission_paid_at:`, referralError.message);
        // Non-fatal — approval row already updated; log and continue.
      }
    }

    // ── Send confirmation email to partner ───────────────────────────────────
    let partnerEmail: string | null = null;
    if (approval.partner_id) {
      const { data: partnerData } = await supabase
        .from("referral_agents")
        .select("email, first_name, last_name")
        .eq("id", approval.partner_id)
        .single();
      partnerEmail = partnerData?.email || null;
      if (partnerData && !approval.partner_name) {
        // Use fetched name if approval row has no partner_name stored
        approval.partner_name = [partnerData.first_name, partnerData.last_name].filter(Boolean).join(" ") || "Partner";
      }
    }

    let emailSent = false;
    if (partnerEmail) {
      const amount      = formatCurrency(Number(approval.amount));
      const payoutType  = formatPayoutType(approval.payout_type);
      const partnerName = approval.partner_name || "Partner";

      const subject = `Your ${payoutType.toLowerCase()} of ${amount} has been approved`;

      const bodyHtml = `
<h2 style="font-size:1.5rem;font-weight:700;color:#0B1929;margin:0 0 8px;">
  Great news — your commission is approved!
</h2>
<p style="color:#374151;font-size:0.95rem;margin:0 0 24px;">
  Hi ${partnerName}, your ${payoutType.toLowerCase()} of <strong>${amount}</strong> has been approved
  and is now processing. You should expect to receive it within the next 1–3 business days.
</p>

<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#F0FDF4;border-radius:8px;border:1px solid #BBF7D0;margin-bottom:24px;">
  <tr>
    <td style="padding:20px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:4px 0;font-size:0.875rem;color:#64748B;width:140px;">Commission Type</td>
          <td style="padding:4px 0;font-size:0.875rem;font-weight:600;color:#0B1929;">${payoutType}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-size:0.875rem;color:#64748B;">Amount</td>
          <td style="padding:4px 0;font-size:1.25rem;font-weight:700;color:#10B981;">${amount}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-size:0.875rem;color:#64748B;">Status</td>
          <td style="padding:4px 0;font-size:0.875rem;font-weight:600;color:#10B981;">✓ Approved</td>
        </tr>
      </table>
    </td>
  </tr>
</table>

${ctaButton("View Your Dashboard →", PARTNER_DASH_URL)}

<p style="font-size:0.8rem;color:#94A3B8;">
  Thank you for being an Otter Quotes partner. Questions? Email us at
  <a href="mailto:support@otterquote.com" style="color:#0EA5E9;">support@otterquote.com</a>.
</p>
`;

      const bodyText = [
        `Hi ${partnerName},`,
        ``,
        `Your ${payoutType.toLowerCase()} of ${amount} has been approved and is now processing.`,
        `Expected arrival: 1–3 business days.`,
        ``,
        `View your dashboard: ${PARTNER_DASH_URL}`,
      ].join("\n");

      const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;
      emailSent = await sendMailgunEmail(mailgunApiKey, mailgunDomain, partnerEmail,
        fromAddress, subject, bodyText, buildEmail(bodyHtml));
    }

    console.log(`[${FUNCTION_NAME}] Approved payout ${payoutApprovalId} — partner email ${emailSent ? "sent" : partnerEmail ? "FAILED" : "skipped (no email)"}`);

    return new Response(JSON.stringify({ ok: true, approval_id: payoutApprovalId, partner_email_sent: emailSent }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Unhandled error:`, err);
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
  