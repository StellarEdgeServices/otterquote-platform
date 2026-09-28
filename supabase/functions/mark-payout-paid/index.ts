/**
 * OtterQuote Edge Function: mark-payout-paid
 *
 * D-293 — Manual Commission Payment, step 2: "I sent the money"
 *
 * Split from approve-payout (gh-1155, child of #1021). approve-payout is now
 * authorization only ("I authorized this") — it no longer touches referral
 * payment state. This function is the second, separate human action that
 * records "I sent the money":
 *   1. Sets payout_approvals.status = 'approved' -> 'paid', paid_at = NOW()
 *   2. Sets referrals.commission_paid_at = NOW() and referrals.status =
 *      'commission_paid' (fires update_referral_stats) on the associated
 *      referral — the same write that used to live in approve-payout, now
 *      gated on 'paid' instead of 'approved', and performed after the
 *      payout_approvals write above.
 *   3. Sends a Mailgun "marked as paid" confirmation email to the partner
 *
 * Input: POST { payout_approval_id: string }
 * Output: { ok: true, approval_id: string }
 *
 * Auth: Requires valid Supabase JWT with email in ADMIN_EMAILS (same
 * allow-list as approve-payout / reject-payout).
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN
 *
 * GitHub: gh-1155 (child of #1021, D-293)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { paidEmailText, paidEmailHtml, formatCurrency, formatPayoutType } from "./templates.ts"; // gh-1824: email bodies moved to templates.ts (testable, no serve() import)

const FUNCTION_NAME     = "mark-payout-paid";
// Same admin allow-list as approve-payout / reject-payout (D-211 Phase 18 Unit 2).
// gh-1534: kept in sync with supabase/functions/_shared/admin.ts ADMIN_EMAILS — do not
// edit this array without updating that file too (deploy path does not resolve imports).
const ADMIN_EMAILS      = ["dustinstohler1@gmail.com", "dustin@otterquote.com"];

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

  if (userError || !userData?.user || !ADMIN_EMAILS.includes(userData.user.email ?? "")) {
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
    } else if (rlData?.allowed === false) {
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

    // ── Idempotency: only act on approved rows ───────────────────────────────
    // Covers a repeated call after this row already reached 'paid' (or is in
    // any other non-'approved' state) — no action taken, no duplicate writes
    // or emails.
    if (approval.status !== "approved") {
      return new Response(JSON.stringify({
        ok: true,
        sent: false,
        reason: `Already in status '${approval.status}' — no action taken`,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── W-9 / payments gate (copy of approve-payout's gate, D-211 Phase 18 Unit 2) ──
    // A payout must not reach 'paid' without a verified W-9 and unblocked
    // payments — re-checked here (not only at approve time) because a
    // partner's W-9/payments-blocked state can change between approve and
    // mark-paid. Fail-safe: a missing partner_id / agent row / lookup error
    // HOLDS — the row stays 'approved' and neither paid_at nor
    // commission_paid_at is ever set. Held is returned as { ok:false,
    // held:true } with `error`.
    const heldResponse = (reason: string) =>
      new Response(JSON.stringify({ ok: false, held: true, reason, error: reason }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    if (!approval.partner_id) {
      console.log(`[${FUNCTION_NAME}] HELD ${payoutApprovalId} — no partner_id on approval row`);
      return heldResponse("Held — no partner on file; cannot verify W-9");
    }

    const { data: agent, error: agentError } = await supabase
      .from("referral_agents")
      .select("payments_blocked, w9_verified_at, email, first_name, last_name")
      .eq("id", approval.partner_id)
      .single();

    if (agentError || !agent) {
      console.log(`[${FUNCTION_NAME}] HELD ${payoutApprovalId} — partner ${approval.partner_id} not resolvable (${agentError?.message ?? "no row"})`);
      return heldResponse("Held — partner record not found; cannot verify W-9");
    }

    if (agent.payments_blocked !== false || agent.w9_verified_at == null) {
      console.log(`[${FUNCTION_NAME}] HELD ${payoutApprovalId} — partner ${approval.partner_id} payments_blocked=${agent.payments_blocked} w9_verified_at=${agent.w9_verified_at}`);
      return heldResponse(
        agent.payments_blocked !== false
          ? "Held — partner payments are blocked (W-9 not on file)"
          : "Held — partner W-9 not on file"
      );
    }

    const now = new Date().toISOString();

    // ── Update payout_approvals: approved -> paid ────────────────────────────
    // Atomic status guard (mirrors approve-payout's pending_approval guard):
    // the JS pre-check above is advisory only. Constrain the UPDATE itself to
    // status = 'approved' and treat 0 rows updated as a concurrent-processing
    // conflict — before commission_paid_at or the email — so a concurrent
    // double-click 409s instead of double-writing.
    const { data: updatedRows, error: updateError } = await supabase
      .from("payout_approvals")
      .update({
        status:  "paid",
        paid_at: now,
      })
      .eq("id", payoutApprovalId)
      .eq("status", "approved")
      .select("id");

    if (updateError) {
      console.error(`[${FUNCTION_NAME}] Failed to update payout_approvals:`, updateError.message);
      return new Response(JSON.stringify({ ok: false, error: "Database update failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!updatedRows || updatedRows.length === 0) {
      console.warn(`[${FUNCTION_NAME}] Conflict — payout ${payoutApprovalId} was no longer 'approved' at UPDATE time (processed concurrently)`);
      return new Response(JSON.stringify({ ok: false, error: "Conflict — payout already processed (status changed since it was loaded)" }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Set referrals.commission_paid_at ─────────────────────────────────────
    // Moved here from approve-payout (gh-1155): this is now the only place
    // that advances a referral to commission_paid — one step later than
    // authorization, and only once the payout has actually reached 'paid'.
    if (approval.referral_id) {
      // gh-2105 (batch 2, decision b): `.select(` added for auditability
      // (update-no-select-ok: the `.is(commission_paid_at, null)` filter is
      // itself the idempotency guard -- "only set if not already paid" -- so
      // a zero-row match here just means the referral was already marked
      // paid, which is the expected steady state, not a silent failure).
      const { data: commissionRows, error: referralError } = await supabase
        .from("referrals")
        .update({ commission_paid_at: now })
        .eq("id", approval.referral_id)
        .is("commission_paid_at", null) // Only set if not already paid
        .select("id");

      if (referralError) {
        console.error(`[${FUNCTION_NAME}] Failed to update referral commission_paid_at:`, referralError.message);
        // Non-fatal — approval row already updated; log and continue.
      } else if (commissionRows && commissionRows.length === 0) {
        console.log(`[${FUNCTION_NAME}] referral ${approval.referral_id} commission_paid_at already set — no-op.`);
      }

      // D-139 (#567): advance the referral to commission_paid so the
      // update_referral_stats trigger fires — nothing else ever sets it.
      // gh-2105 (batch 2, decision b): `.select(` added for auditability
      // (update-no-select-ok: the `.neq(status, commission_paid)` filter is
      // the same idempotency guard -- a zero-row match means the referral's
      // status was already 'commission_paid', not a silent failure).
      const { data: statusRows, error: statusError } = await supabase
        .from("referrals")
        .update({ status: "commission_paid" })
        .eq("id", approval.referral_id)
        .neq("status", "commission_paid")
        .select("id");

      if (statusError) {
        console.error(`[${FUNCTION_NAME}] Failed to update referral status:`, statusError.message);
        // Non-fatal — approval row already updated; log and continue.
      } else if (statusRows && statusRows.length === 0) {
        console.log(`[${FUNCTION_NAME}] referral ${approval.referral_id} status already 'commission_paid' — no-op.`);
      }
    }

    // ── Send "marked as paid" confirmation email to partner ─────────────────
    // Reuse the agent row already loaded by the W-9 gate above (same columns).
    const partnerEmail: string | null = agent.email || null;
    if (!approval.partner_name) {
      // Use fetched name if approval row has no partner_name stored
      approval.partner_name = [agent.first_name, agent.last_name].filter(Boolean).join(" ") || "Partner";
    }

    let emailSent = false;
    if (partnerEmail) {
      const amount      = formatCurrency(Number(approval.amount));
      const payoutType  = formatPayoutType(approval.payout_type);
      const partnerName = approval.partner_name || "Partner";

      const subject = `Your ${payoutType.toLowerCase()} of ${amount} has been paid`;

      const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;
      emailSent = await sendMailgunEmail(mailgunApiKey, mailgunDomain, partnerEmail,
        fromAddress, subject, paidEmailText(partnerName, payoutType, amount), paidEmailHtml(partnerName, payoutType, amount));
    }

    console.log(`[${FUNCTION_NAME}] Marked payout ${payoutApprovalId} paid — partner email ${emailSent ? "sent" : partnerEmail ? "FAILED" : "skipped (no email)"}`);

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
