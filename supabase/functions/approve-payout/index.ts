/**
 * OtterQuote Edge Function: approve-payout
 *
 * D-180 — Admin Commission Approval
 *
 * Approves a pending commission. Admin-only (JWT must be dustinstohler1@gmail.com).
 * On approval:
 *   1. Sets payout_approvals.status = 'approved', approved_at = NOW(), approved_by = 'admin'
 *   2. Sets referrals.commission_paid_at = NOW() and referrals.status =
 *      'commission_paid' (fires update_referral_stats) on the associated referral
 *   3. Sends a Mailgun confirmation email to the partner
 *
 * Input: POST { payout_approval_id: string, override_incomplete?: boolean }
 *   override_incomplete — admin explicitly releases a commission whose linked
 *   job is not yet complete (D-139, #567). admin-payouts.html shows a warning
 *   dialog before sending it.
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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { isW9GateHeld, readW9GateFlag, w9GateHeldReason } from "./w9-gate.ts";
import { approvalEmailText, approvalEmailHtml, formatPayoutType } from "./templates.ts"; // gh-1824: email bodies moved to templates.ts (testable, no serve() import)

const FUNCTION_NAME     = "approve-payout";
// D-211 Phase 18 Unit 2: admin allow-list (was single ADMIN_EMAIL). Admit either operator email.
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
    const overrideIncomplete = body.override_incomplete === true;
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

    // ── W-9 / payments gate (D-211 Phase 18 Unit 2) ──────────────────────────
    // Flipping status to 'approved' + stamping commission_paid_at is the terminal
    // money-state (no separate Stripe disbursement EF). Never cross that line for a
    // partner without a verified W-9 and unblocked payments. Fail-safe: a missing
    // partner_id / agent row / lookup error HOLDS — the row stays pending_approval
    // and commission_paid_at is never set. Held is returned as { ok:false, held:true }
    // with `error` so admin-payouts.html surfaces the reason (and skips its
    // optimistic "approved" row update, which only runs on the ok:true path).
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

    // D-319 (gh-1509 half A): platform_settings.w9_gate_retired — flag OFF
    // (default; no row yet, this PR ships no seed/migration) is byte-identical
    // to the pre-D-319 inline guard below. Flag ON retires ONLY the
    // w9_verified_at condition; payments_blocked is still authoritative
    // either way (see w9-gate.ts header comment for the reasoning).
    const w9GateRetired = await readW9GateFlag(
      async () => await supabase.from("platform_settings").select("value").eq("key", "w9_gate_retired").maybeSingle(),
      (msg) => console.error(`[${FUNCTION_NAME}] ${msg}`)
    );

    if (isW9GateHeld(agent, w9GateRetired)) {
      console.log(`[${FUNCTION_NAME}] HELD ${payoutApprovalId} — partner ${approval.partner_id} payments_blocked=${agent.payments_blocked} w9_verified_at=${agent.w9_verified_at} w9_gate_retired=${w9GateRetired}`);
      return heldResponse(w9GateHeldReason(agent));
    }

    // ── Completion gate (D-139, #567) ────────────────────────────────────────
    // Commissions are payable after job completion. Resolve referral → claim →
    // completion_date. An incomplete (or unverifiable) job HOLDS unless the
    // admin explicitly passed override_incomplete: true — admin-payouts.html
    // shows a warning dialog before sending it. Fail-safe: lookup error with
    // no override = hold.
    if (!overrideIncomplete) {
      let jobComplete = false;
      let completionCheckError: string | null = null;

      if (approval.referral_id) {
        const { data: refRow, error: refErr } = await supabase
          .from("referrals")
          .select("claim_id")
          .eq("id", approval.referral_id)
          .single();
        if (refErr) {
          completionCheckError = `referral lookup failed: ${refErr.message}`;
        } else if (refRow?.claim_id) {
          const { data: claimRow, error: claimErr } = await supabase
            .from("claims")
            .select("completion_date")
            .eq("id", refRow.claim_id)
            .single();
          if (claimErr) {
            completionCheckError = `claim lookup failed: ${claimErr.message}`;
          } else if (claimRow?.completion_date != null) {
            jobComplete = true;
          }
        }
      }

      if (!jobComplete) {
        console.log(`[${FUNCTION_NAME}] HELD ${payoutApprovalId} — job not complete (referral ${approval.referral_id ?? "none"}${completionCheckError ? `; ${completionCheckError}` : ""})`);
        return heldResponse(
          completionCheckError
            ? "Held — could not verify job completion; resolve the lookup error or approve with the incomplete-job override"
            : "Held — job not marked complete (D-139: commissions pay after completion); approve with the incomplete-job override to release early"
        );
      }
    }

    const now = new Date().toISOString();

    // ── Update payout_approvals ──────────────────────────────────────────────
    // Atomic status guard (86e1xrwq2 #1): the JS pre-check above is advisory only.
    // Constrain the UPDATE itself to pending_approval (mirrors the
    // process-payout-reminders auto-approve guard) and treat 0 rows updated as a
    // concurrent-processing conflict — before commission_paid_at or the email.
    const { data: updatedRows, error: updateError } = await supabase
      .from("payout_approvals")
      .update({
        status:      "approved",
        approved_at: now,
        approved_by: "admin",
      })
      .eq("id", payoutApprovalId)
      .eq("status", "pending_approval")
      .select("id");

    if (updateError) {
      console.error(`[${FUNCTION_NAME}] Failed to update payout_approvals:`, updateError.message);
      return new Response(JSON.stringify({ ok: false, error: "Database update failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!updatedRows || updatedRows.length === 0) {
      console.warn(`[${FUNCTION_NAME}] Conflict — payout ${payoutApprovalId} was no longer pending_approval at UPDATE time (processed concurrently)`);
      return new Response(JSON.stringify({ ok: false, error: "Conflict — payout already processed (status changed since it was loaded)" }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Send confirmation email to partner ───────────────────────────────────
    // Reuse the agent row already loaded by the W-9 gate above (same columns).
    const partnerEmail: string | null = agent.email || null;
    if (!approval.partner_name) {
      // Use fetched name if approval row has no partner_name stored
      approval.partner_name = [agent.first_name, agent.last_name].filter(Boolean).join(" ") || "Partner";
    }

    let emailSent = false;
    if (partnerEmail) {
      const payoutType  = formatPayoutType(approval.payout_type);
      const partnerName = approval.partner_name || "Partner";

      // D-307 (board Q22, 2026-08-19, gh-1055): the job amount is hidden from
      // ALL partner-facing email, not just the progress series. Q26 (may a
      // partner see their OWN referral fee amount in their OWN
      // payment-confirmation email) was unanswered as of this change — the
      // conservative reading governs per the issue: suppress the figure here
      // too and point the partner at their dashboard for it.
      const subject = `Your ${payoutType.toLowerCase()} has been approved`;

      const fromAddress = `Otter Quotes <notifications@${mailgunDomain}>`;
      emailSent = await sendMailgunEmail(mailgunApiKey, mailgunDomain, partnerEmail,
        fromAddress, subject, approvalEmailText(partnerName, payoutType), approvalEmailHtml(partnerName, payoutType));
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
