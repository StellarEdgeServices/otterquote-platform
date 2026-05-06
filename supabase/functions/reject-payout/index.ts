/**
 * OtterQuote Edge Function: reject-payout
 *
 * D-180 — Admin Commission Rejection
 *
 * Rejects a pending commission. Admin-only (JWT must be dustinstohler1@gmail.com).
 * Rejected commissions are DEFERRED, not voided — status = 'rejected' with a
 * required reason. They can be re-approved by calling approve-payout later.
 *
 * On rejection:
 *   1. Sets payout_approvals.status = 'rejected', rejected_at = NOW(), rejection_reason = <reason>
 *   2. Does NOT touch commission_paid_at (commission stays in ledger — deferred, not voided)
 *
 * Input: POST { payout_approval_id: string, rejection_reason: string }
 * Output: { ok: true, approval_id: string }
 *
 * Auth: Requires valid Supabase JWT with email = dustinstohler1@gmail.com.
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * ClickUp: 86e1160qg
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "reject-payout";
const ADMIN_EMAIL   = "dustinstohler1@gmail.com";

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

  if (!supabaseUrl || !serviceRoleKey) {
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
    const rejectionReason  = (body.rejection_reason as string || "").trim();

    if (!payoutApprovalId) {
      return new Response(JSON.stringify({ ok: false, error: "payout_approval_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // D-180 spec: rejection_reason is required — cannot be empty.
    if (!rejectionReason) {
      return new Response(JSON.stringify({ ok: false, error: "rejection_reason is required — cannot reject without a reason" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Minimum length guard to prevent accidental single-character submissions.
    if (rejectionReason.length < 5) {
      return new Response(JSON.stringify({ ok: false, error: "rejection_reason must be at least 5 characters" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // String length cap — DB column is TEXT but we cap at a reasonable limit.
    if (rejectionReason.length > 2000) {
      return new Response(JSON.stringify({ ok: false, error: "rejection_reason must be 2000 characters or fewer" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Load the approval row ────────────────────────────────────────────────
    const { data: approval, error: approvalError } = await supabase
      .from("payout_approvals")
      .select("id, status, partner_name, amount, payout_type")
      .eq("id", payoutApprovalId)
      .single();

    if (approvalError || !approval) {
      return new Response(JSON.stringify({ ok: false, error: "Approval not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Only pending_approval rows can be rejected.
    if (approval.status !== "pending_approval") {
      return new Response(JSON.stringify({
        ok: false,
        error: `Cannot reject — current status is '${approval.status}'. Only 'pending_approval' rows can be rejected.`,
      }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Update payout_approvals ──────────────────────────────────────────────
    // D-180: status = 'rejected', rejected_at = NOW(), rejection_reason = <value>.
    // commission_paid_at on referrals is intentionally NOT touched —
    // rejected commission is deferred (can be re-approved), not voided.
    const { error: updateError } = await supabase
      .from("payout_approvals")
      .update({
        status:           "rejected",
        rejected_at:      new Date().toISOString(),
        rejection_reason: rejectionReason,
      })
      .eq("id", payoutApprovalId);

    if (updateError) {
      console.error(`[${FUNCTION_NAME}] Failed to update payout_approvals:`, updateError.message);
      return new Response(JSON.stringify({ ok: false, error: "Database update failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[${FUNCTION_NAME}] Rejected payout ${payoutApprovalId} — ${approval.partner_name} — reason: ${rejectionReason.substring(0, 80)}`);

    return new Response(JSON.stringify({ ok: true, approval_id: payoutApprovalId }), {
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