/**
 * OtterQuote Edge Function: notify-payout-pending
 *
 * D-180 — Immediate Payout Approval Request Email
 *
 * Called when a new payout_approvals row is created (status='pending_approval').
 * Invoked by the apply_referral_commission() trigger via pg_net.http_post(),
 * or can be called manually/from process-payout-reminders for catch-up runs.
 *
 * Auth: verify_jwt = false (see supabase/config.toml). Invoked by the
 *   apply_referral_commission() DB trigger via pg_net with service role bearer,
 *   and by process-payout-reminders for catch-up runs. A CRON_SECRET gate is
 *   deferred — requires Tier 3 SQL migration to update pg_net call in the trigger.
 *   Idempotency (notification_sent_at) and rate limiting provide abuse defense.
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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  formatCurrency,
  formatPayoutType,
  payoutPendingEmailHtml,
  payoutPendingEmailText,
} from "./templates.ts"; // gh-1824: email bodies moved to templates.ts (testable, no serve() import)

const FUNCTION_NAME = "notify-payout-pending";
const ADMIN_EMAIL   = "dustinstohler1@gmail.com";

// CORS: allowlisted (admin + internal use only).
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
      p_user_id: null,
    });
    if (rlError) {
      console.error(`[${FUNCTION_NAME}] Rate limit RPC error:`, rlError.message);
    } else if (rlData?.allowed === false) {
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

    const bodyHtml = payoutPendingEmailHtml(partnerName, amount, payoutType, autoApproveOn, triggerEvent, payoutApprovalId);
    const bodyText = payoutPendingEmailText(partnerName, amount, payoutType, autoApproveOn, triggerEvent);

    const fromAddress = `Otter Quotes Admin <notifications@${mailgunDomain}>`;
    const sent = await sendMailgunEmail(
      mailgunApiKey,
      mailgunDomain,
      ADMIN_EMAIL,
      fromAddress,
      subject,
      bodyText,
      bodyHtml
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
