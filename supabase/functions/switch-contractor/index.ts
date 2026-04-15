/**
 * OtterQuote Edge Function: switch-contractor
 *
 * Allows a homeowner to switch contractors after contract signing,
 * provided the installation date is more than 3 days away (D-025 / D-041 / D-137).
 *
 * Flow:
 *   1. Verify homeowner JWT and claim ownership
 *   2. Verify claim status is 'contract_signed' or 'awarded'
 *   3. Check the 3-day window: reject if estimated_start_date <= today + 3 days
 *   4. Load the winning quote for this claim
 *   5. Cancel the quote (status = 'cancelled', cancelled_at = NOW())
 *   6. Reset the claim (status = 'bidding', selected_contractor_id = NULL,
 *      increment contractor_switch_count, set contractor_switched_at)
 *   7. If the quote has a succeeded Stripe PaymentIntent, issue a full refund
 *   8. Send email to the original contractor notifying them of the switch
 *      and confirming their platform fee refund
 *   9. Re-fire notify-contractors so the network knows the project is open again
 *  10. Log to activity_log
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   STRIPE_SECRET_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

// CORS tightened Apr 15, 2026 (Session 181, ClickUp 86e0xhz2j): sensitive
// function (homeowner JWT, Stripe refunds, contractor emails) — origin allowlisted.
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

/** Days before installation at which switching is no longer allowed. */
const SWITCH_CUTOFF_DAYS = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Returns true if the installation date is within the cutoff window. */
function isWithinCutoff(estimatedStartDate: string | null): boolean {
  if (!estimatedStartDate) return false; // no date set → always allow switch
  const installDate = new Date(estimatedStartDate);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + SWITCH_CUTOFF_DAYS);
  return installDate <= cutoff;
}

/** Issue a Stripe refund for a given PaymentIntent. Returns true on success. */
async function stripeRefund(
  stripeKey: string,
  paymentIntentId: string
): Promise<{ success: boolean; refundId?: string; error?: string }> {
  try {
    // 1. Retrieve the PaymentIntent to get the charge ID
    const piRes = await fetch(
      `${STRIPE_API_BASE}/payment_intents/${paymentIntentId}`,
      {
        headers: {
          Authorization: `Basic ${btoa(stripeKey + ":")}`,
        },
      }
    );
    if (!piRes.ok) {
      const err = await piRes.text();
      console.error("[switch-contractor] Stripe PI fetch error:", err);
      return { success: false, error: `Stripe PI fetch failed: ${piRes.status}` };
    }
    const pi = await piRes.json();
    const chargeId: string | null = pi.latest_charge || null;

    if (!chargeId) {
      return {
        success: false,
        error: "PaymentIntent has no associated charge — may not have been captured.",
      };
    }

    // 2. Issue a full refund on the charge
    const refundFormData = new URLSearchParams();
    refundFormData.append("charge", chargeId);
    refundFormData.append("reason", "requested_by_customer");
    refundFormData.append("metadata[reason]", "homeowner_switched_contractor");

    const refundRes = await fetch(`${STRIPE_API_BASE}/refunds`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(stripeKey + ":")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: refundFormData,
    });

    if (!refundRes.ok) {
      const err = await refundRes.text();
      console.error("[switch-contractor] Stripe refund error:", err);
      return { success: false, error: `Stripe refund failed: ${refundRes.status}` };
    }

    const refund = await refundRes.json();
    console.log("[switch-contractor] Stripe refund issued:", refund.id, "status:", refund.status);
    return { success: true, refundId: refund.id };
  } catch (err) {
    console.error("[switch-contractor] stripeRefund threw:", err);
    return { success: false, error: String(err) };
  }
}

/** Send an email via Mailgun. */
async function sendEmail(
  apiKey: string,
  domain: string,
  to: string,
  from: string,
  subject: string,
  text: string
): Promise<boolean> {
  const basicAuth = btoa(`api:${apiKey}`);
  const formData = new URLSearchParams();
  formData.append("from", from);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", text);

  try {
    const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: { Authorization: `Basic ${basicAuth}` },
      body: formData,
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[switch-contractor] Mailgun error:", err);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[switch-contractor] sendEmail threw:", err);
    return false;
  }
}

// ─── Main Handler ────────────────────────────────────────────────────────────

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);

  // jsonResponse is defined inside the handler so it closes over the
  // per-request corsHeaders (Origin-aware).
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl   = Deno.env.get("SUPABASE_URL")!;
  const serviceKey    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const stripeKey     = Deno.env.get("STRIPE_SECRET_KEY") || "";
  const mailgunKey    = Deno.env.get("MAILGUN_API_KEY") || "";
  const mailgunDomain = Deno.env.get("MAILGUN_DOMAIN") || "";

  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Missing Authorization header" }, 401);
  }
  const jwt = authHeader.replace("Bearer ", "");

  // Create a user-scoped client to validate the JWT
  const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") || serviceKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    return jsonResponse({ error: "Invalid or expired session" }, 401);
  }

  // Admin (service-role) client for writes
  const sb = createClient(supabaseUrl, serviceKey);

  try {
    const { claim_id, reason } = await req.json();

    if (!claim_id) {
      return jsonResponse({ error: "claim_id is required" }, 400);
    }

    // ── 2. Load claim & verify ownership ──────────────────────────────────
    const { data: claim, error: claimError } = await sb
      .from("claims")
      .select("*")
      .eq("id", claim_id)
      .single();

    if (claimError || !claim) {
      return jsonResponse({ error: "Claim not found" }, 404);
    }

    if (claim.user_id !== user.id) {
      return jsonResponse({ error: "Unauthorized — this is not your claim" }, 403);
    }

    // ── 3. Verify claim is in a switchable state ──────────────────────────
    const switchableStatuses = ["contract_signed", "awarded"];
    if (!switchableStatuses.includes(claim.status)) {
      return jsonResponse({
        error: `Cannot switch contractor — claim status is '${claim.status}'. Switching is only available after contract signing.`,
      }, 400);
    }

    // ── 4. Check 3-day window ─────────────────────────────────────────────
    if (isWithinCutoff(claim.estimated_start_date)) {
      return jsonResponse({
        error: `Switching is no longer available — your installation is within ${SWITCH_CUTOFF_DAYS} days.`,
        code: "WITHIN_CUTOFF",
      }, 400);
    }

    // ── 5. Load the winning quote ─────────────────────────────────────────
    const { data: winningQuote, error: quoteError } = await sb
      .from("quotes")
      .select("*, contractors(id, company_name, email, user_id)")
      .eq("claim_id", claim_id)
      .in("status", ["selected", "awarded", "submitted"])
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    // It's OK if there's no quote record (e.g., older flow) — we continue
    const contractor = winningQuote?.contractors;
    const contractorEmail = contractor?.email || null;
    const contractorName  = contractor?.company_name || "Your contractor";
    console.log("[switch-contractor] Winning quote:", winningQuote?.id, "contractor:", contractorName);

    // ── 6. Cancel the quote ───────────────────────────────────────────────
    if (winningQuote?.id) {
      const { error: cancelError } = await sb
        .from("quotes")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          cancellation_reason: "homeowner_switched_contractor",
        })
        .eq("id", winningQuote.id);

      if (cancelError) {
        console.error("[switch-contractor] Error cancelling quote:", cancelError);
        // Non-fatal — continue
      }
    }

    // ── 7. Reset the claim ────────────────────────────────────────────────
    const { error: claimUpdateError } = await sb
      .from("claims")
      .update({
        status: "bidding",
        selected_contractor_id: null,
        contractor_switched_at: new Date().toISOString(),
        contractor_switch_count: (claim.contractor_switch_count || 0) + 1,
      })
      .eq("id", claim_id);

    if (claimUpdateError) {
      console.error("[switch-contractor] Error resetting claim:", claimUpdateError);
      return jsonResponse({ error: "Failed to reset claim status. Please try again." }, 500);
    }

    // ── 8. Stripe refund ──────────────────────────────────────────────────
    let refundResult = { success: false, refundId: undefined as string | undefined, error: "No payment found" };

    if (winningQuote?.payment_intent_id && winningQuote?.payment_status === "succeeded" && stripeKey) {
      console.log("[switch-contractor] Issuing Stripe refund for PI:", winningQuote.payment_intent_id);
      refundResult = await stripeRefund(stripeKey, winningQuote.payment_intent_id);

      // Update the quote with refund info
      if (refundResult.success && refundResult.refundId) {
        await sb.from("quotes").update({
          payment_status: "refunded",
        }).eq("id", winningQuote.id);
      }
    } else {
      console.log("[switch-contractor] No Stripe refund needed — payment_intent_id:", winningQuote?.payment_intent_id, "payment_status:", winningQuote?.payment_status);
      refundResult = { success: true, refundId: undefined, error: "No fee charged — no refund needed" };
    }

    // ── 9. Notify original contractor ─────────────────────────────────────
    let emailSent = false;
    if (contractorEmail && mailgunKey && mailgunDomain) {
      const refundLine = refundResult.success && refundResult.refundId
        ? "Your platform fee has been refunded in full and will appear in your account within 5–10 business days."
        : refundResult.success
          ? "No platform fee had been charged on this project, so no refund is necessary."
          : "We will process your platform fee refund separately. Please contact support at support@otterquote.com if you have questions.";

      const emailText = `Hi ${contractorName},

We're writing to let you know that the homeowner on the following project has chosen to switch contractors through OtterQuote.

This is a platform feature available to homeowners up to 3 days before their scheduled installation date.

${refundLine}

The project has been re-opened to the OtterQuote contractor network. You are welcome to bid again when it reappears in your Opportunities dashboard.

We appreciate your participation on OtterQuote and look forward to connecting you with future projects.

Best regards,
The OtterQuote Team
support@otterquote.com | (844) 875-3412`;

      emailSent = await sendEmail(
        mailgunKey,
        mailgunDomain,
        contractorEmail,
        `OtterQuote <notifications@${mailgunDomain}>`,
        "Project Update — Contractor Switch",
        emailText
      );
      console.log("[switch-contractor] Contractor notification email sent:", emailSent);
    }

    // ── 10. Re-notify contractor network ──────────────────────────────────
    // Fire-and-forget — don't block the response on this
    try {
      const addressParts = (claim.property_address || "").split(",");
      const notifyPayload = {
        claim_id: claim_id,
        claim_city:  claim.address_city  || addressParts[0]?.trim() || "Unknown",
        claim_state: claim.address_state || "IN",
        claim_zip:   claim.address_zip   || claim.property_address?.match(/\d{5}/)?.[0] || "",
        trade_types: claim.selected_trades || claim.trades || ["roofing"],
        job_type:    claim.job_type || "insurance_rcv",
        urgency:     claim.urgency  || "flexible",
      };

      fetch(`${supabaseUrl}/functions/v1/notify-contractors`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceKey}`,
        },
        body: JSON.stringify(notifyPayload),
      }).then(r => r.json())
        .then(result => console.log("[switch-contractor] notify-contractors result:", result))
        .catch(err => console.error("[switch-contractor] notify-contractors error (non-blocking):", err));
    } catch (notifyErr) {
      console.error("[switch-contractor] Error firing notify-contractors:", notifyErr);
    }

    // ── 11. Activity log ──────────────────────────────────────────────────
    await sb.from("activity_log").insert({
      claim_id:    claim_id,
      event_type:  "contractor_switched",
      description: `Homeowner switched contractors. Original contractor: ${contractorName}. Refund: ${refundResult.success ? "issued" : "pending"}.`,
      created_at:  new Date().toISOString(),
    }).catch(err => console.warn("[switch-contractor] Activity log insert failed (non-critical):", err));

    // ── Done ──────────────────────────────────────────────────────────────
    return jsonResponse({
      success: true,
      message: "Contractor switch initiated. Your project is back in open bidding.",
      refund_issued: refundResult.success,
      refund_id: refundResult.refundId || null,
      contractor_notified: emailSent,
    });

  } catch (err) {
    console.error("[switch-contractor] Unhandled error:", err);
    return jsonResponse({ error: "An unexpected error occurred. Please try again." }, 500);
  }
});
