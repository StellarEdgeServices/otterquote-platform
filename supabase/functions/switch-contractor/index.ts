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
 *   7b. Persist D-171 survey payload to claims.switch_reason_survey
 *   8. Send email to the original contractor notifying them of the switch
 *      and confirming their platform fee refund
 *   9. Re-fire notify-contractors so the network knows the project is open again
 *   9b. Send support notification to Dustin with survey payload (D-171)
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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { checkRowsWritten, zeroRowWriteMessage } from "../_shared/zero-row-update-guard.ts";
import {
  contractorSwitchEmailHtml,
  contractorSwitchEmailText,
  switchSupportEmailText,
} from "./templates.ts"; // gh-1824: email bodies moved to templates.ts (testable, no serve() import)

const STRIPE_API_BASE = "https://api.stripe.com/v1";

// CORS tightened Apr 15, 2026 (Session 181, ClickUp 86e0xhz2j): sensitive
// function (homeowner JWT, Stripe refunds, contractor emails) — origin allowlisted.
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

// gh-1824: escapeHtml/buildEmail/contractorSwitchEmailHtml moved to
// ./templates.ts (testable without importing this file's top-level serve()
// call). See templates.ts / templates.test.ts.

/** Send an email via Mailgun. Optional html param — gh-1013 adds it only where a customer/contractor-facing send needs parity; internal alert sends stay text-only. */
async function sendEmail(
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
  // Staging detection — use test-mode key when origin is staging (fix #86e19wk6z).
  // gh-1536: exact-match, not substring — "app-staging." falsely matched
  // app-staging.otterquote.com, a Netlify DOMAIN ALIAS on the PRODUCTION app
  // site (not staging), which selected Stripe TEST-mode keys against real
  // production data. This must never match a production hostname.
  const _reqOrigin = req.headers.get("Origin") || "";
  const isStaging = _reqOrigin === "https://jade-alpaca-b82b5e.netlify.app" ||
    _reqOrigin === "https://staging--jade-alpaca-b82b5e.netlify.app";
  const stripeKey = isStaging
    ? (Deno.env.get("STRIPE_SECRET_KEY_TEST") || Deno.env.get("STRIPE_SECRET_KEY") || "")
    : (Deno.env.get("STRIPE_SECRET_KEY") || "");
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
    const body = await req.json();
    const { claim_id, reason } = body;
    // D-171: survey payload (optional — backwards compatible)
    const surveyReasons: string[] = Array.isArray(body.survey_reasons) ? body.survey_reasons : [];
    const surveyNotes: string = typeof body.survey_notes === "string"
      ? body.survey_notes.trim().slice(0, 1000)
      : "";

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
    // Scoped to the selected contractor so we never refund the wrong quote.
    let winningQuote: any = null;
    if (claim.selected_contractor_id) {
      const { data: quote } = await sb
        .from("quotes")
        .select("*, contractors(id, company_name, email, user_id)")
        .eq("claim_id", claim_id)
        .eq("contractor_id", claim.selected_contractor_id)
        .in("status", ["selected", "awarded"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      winningQuote = quote;
    }

    // It's OK if there's no quote record (e.g., older flow) — we continue
    const contractor = winningQuote?.contractors;
    const contractorEmail = contractor?.email || null;
    const contractorName  = contractor?.company_name || "Your contractor";
    console.log("[switch-contractor] Winning quote:", winningQuote?.id, "contractor:", contractorName);

    // ── 6. Cancel the quote ───────────────────────────────────────────────
    if (winningQuote?.id) {
      const { error: cancelError, data: cancelRows } = await sb
        .from("quotes")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          cancellation_reason: "homeowner_switched_contractor",
        })
        .eq("id", winningQuote.id)
        .select("id");

      if (cancelError) {
        console.error("[switch-contractor] Error cancelling quote:", cancelError);
        // Non-fatal — continue
      } else if (!checkRowsWritten(cancelRows).wroteRows) {
        // gh-2105 (decision a, non-fatal like cancelError): `winningQuote` was
        // fetched by this id, so zero rows means the cancel silently did not
        // land and the switched-away quote stays live.
        console.error(zeroRowWriteMessage("switch-contractor", `quotes.status=cancelled for quote ${winningQuote.id}`));
      }
    }

    // ── 7. Reset the claim ────────────────────────────────────────────────
    const { error: claimUpdateError, data: claimUpdateRows } = await sb
      .from("claims")
      .update({
        status: "bidding",
        selected_contractor_id: null,
        contractor_switched_at: new Date().toISOString(),
        contractor_switch_count: (claim.contractor_switch_count || 0) + 1,
      })
      .eq("id", claim_id)
      .select("id");

    if (claimUpdateError) {
      console.error("[switch-contractor] Error resetting claim:", claimUpdateError);
      return jsonResponse({ error: "Failed to reset claim status. Please try again." }, 500);
    }
    // gh-2105 (decision a, money): a zero-row match here would leave the claim
    // awarded while the refund/emails below proceed as if it were reset. Same
    // existing 500 response as claimUpdateError -- no new user-facing text.
    if (!checkRowsWritten(claimUpdateRows).wroteRows) {
      console.error(zeroRowWriteMessage("switch-contractor", `claims.status=bidding for claim ${claim_id}`));
      return jsonResponse({ error: "Failed to reset claim status. Please try again." }, 500);
    }

    // ── 7b. Persist D-171 survey payload ─────────────────────────────────
    if (surveyReasons.length > 0 || surveyNotes) {
      const surveyPayload = {
        reasons: surveyReasons,
        notes: surveyNotes,
        submitted_at: new Date().toISOString(),
      };
      const { error: surveyError, data: surveyRows } = await sb
        .from("claims")
        .update({ switch_reason_survey: surveyPayload })
        .eq("id", claim_id)
        .select("id");
      if (surveyError) {
        console.warn("[switch-contractor] Survey persist failed (non-critical):", surveyError);
      } else if (!checkRowsWritten(surveyRows).wroteRows) {
        // gh-2105 (decision a, non-critical): logged, never fails the switch.
        console.warn(zeroRowWriteMessage("switch-contractor", `claims.switch_reason_survey for claim ${claim_id}`));
      } else {
        console.log("[switch-contractor] Survey saved:", JSON.stringify(surveyPayload));
      }
    }

    // ── 8. Stripe refund ──────────────────────────────────────────────────
    let refundResult = { success: false, refundId: undefined as string | undefined, error: "No payment found" };

    if (winningQuote?.payment_intent_id && winningQuote?.payment_status === "succeeded" && stripeKey) {
      console.log("[switch-contractor] Issuing Stripe refund for PI:", winningQuote.payment_intent_id);
      refundResult = await stripeRefund(stripeKey, winningQuote.payment_intent_id);

      // Update the quote with refund info
      if (refundResult.success && refundResult.refundId) {
        const { error: refundMarkErr, data: refundMarkRows } = await sb.from("quotes").update({
          payment_status: "refunded",
        }).eq("id", winningQuote.id).select("id");
        // gh-2105 (decision a-with-alert, money): the Stripe refund already
        // fired and is irreversible from here, so no throw -- but a silent miss
        // leaves payment_status="succeeded" on a refunded charge.
        if (refundMarkErr || !checkRowsWritten(refundMarkRows).wroteRows) {
          console.error(zeroRowWriteMessage("switch-contractor", `quotes.payment_status=refunded for quote ${winningQuote.id} (refund ${refundResult.refundId})`), refundMarkErr?.message ?? "");
        }
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

      const emailText = contractorSwitchEmailText(contractorName, refundLine); // gh-1824

      emailSent = await sendEmail(
        mailgunKey,
        mailgunDomain,
        contractorEmail,
        `Otter Quotes <notifications@${mailgunDomain}>`,
        "Project Update — Contractor Switch",
        emailText,
        contractorSwitchEmailHtml(contractorName, refundLine)
      );
      console.log("[switch-contractor] Contractor notification email sent:", emailSent);
    }

    // ── 9b. Support notification — D-171 survey payload ──────────────────
    // Email Dustin with the homeowner's switch reason so support can
    // personally confirm next-contractor placement (D-171 spec requirement).
    if (mailgunKey && mailgunDomain) {
      const reasonsLine = surveyReasons.length > 0
        ? surveyReasons.join(", ")
        : "(none selected)";
      const notesLine = surveyNotes || "(none provided)";
      const propertyAddress = claim.property_address || "Unknown address";
      const supportEmailText = switchSupportEmailText(
        claim_id,
        propertyAddress,
        contractorName,
        refundResult.success,
        reasonsLine,
        notesLine,
      ); // gh-1824

      await sendEmail(
        mailgunKey,
        mailgunDomain,
        "dustinstohler1@gmail.com",
        `Otter Quotes <notifications@${mailgunDomain}>`,
        `[Action Required] Homeowner switch request — ${propertyAddress}`,
        supportEmailText
      );
      console.log("[switch-contractor] Support notification sent to Dustin.");
    }

    // ── 10. Re-notify contractor network (D-165: per-trade, release-aware) ──
    // Fire one notify-contractors call per released trade. A trade is "released"
    // if its *_bid_released_at timestamp is non-null on the claim record (which
    // uses select("*") above and therefore includes all v45 columns).
    // This ensures retail siding claims that haven't completed their Hover design
    // (siding_bid_released_at IS NULL) do NOT re-notify siding contractors on switch.
    // Fire-and-forget — don't block the response on this.
    try {
      const addressParts = (claim.property_address || "").split(",");
      const notifyBase = {
        claim_id:    claim_id,
        claim_city:  claim.address_city  || addressParts[0]?.trim() || "Unknown",
        claim_state: claim.address_state || "IN",
        claim_zip:   claim.address_zip   || claim.property_address?.match(/\d{5}/)?.[0] || "",
        job_type:    claim.job_type || "insurance_rcv",
        urgency:     claim.urgency  || "flexible",
      };

      const allTrades: string[] = claim.selected_trades || claim.trades || ["roofing"];
      const KNOWN_TRADES = ["roofing", "gutters", "siding", "windows"];
      const releasedTrades = allTrades.filter((t: string) => {
        const tl = t.toLowerCase();
        if (!KNOWN_TRADES.includes(tl)) return true; // unknown = conservative include
        const col = `${tl}_bid_released_at` as keyof typeof claim;
        return !!(claim as any)[col];
      });

      if (releasedTrades.length === 0) {
        console.log("[switch-contractor] No released trades — skipping re-notification (all held by gates)");
      } else {
        for (const trade of releasedTrades) {
          const notifyPayload = { ...notifyBase, trade_types: [trade] };
          fetch(`${supabaseUrl}/functions/v1/notify-contractors`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
            body: JSON.stringify(notifyPayload),
          }).then(r => r.json())
            .then(result => console.log(`[switch-contractor] notify-contractors [${trade}] result:`, result))
            .catch(err => console.error(`[switch-contractor] notify-contractors [${trade}] error (non-blocking):`, err));
        }
        console.log(`[switch-contractor] Re-notification fired for trades: [${releasedTrades.join(", ")}]`);
      }
    } catch (notifyErr) {
      console.error("[switch-contractor] Error firing notify-contractors:", notifyErr);
    }

    // ── 11. Activity log ──────────────────────────────────────────────────
    const surveyDesc = surveyReasons.length > 0
      ? ` Survey reasons: [${surveyReasons.join(", ")}].${surveyNotes ? ` Notes: "${surveyNotes.slice(0, 200)}"` : ""}`
      : "";
    await sb.from("activity_log").insert({
      event_type:  "contractor_switched",
      title:       `Homeowner switched contractors. Original contractor: ${contractorName}. Refund: ${refundResult.success ? "issued" : "pending"}.${surveyDesc}`,
      user_id:     user.id,
      is_test:     claim.is_test ?? false,
      metadata:    { claim_id },
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
