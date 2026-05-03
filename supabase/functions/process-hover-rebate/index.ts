/**
 * OtterQuote Edge Function: process-hover-rebate
 *
 * D-181 (Apr 23, 2026, ClickUp 86e11mcf4) amended by D-205 (May 2, 2026):
 * Issues a Stripe refund for the homeowner's Hover measurement fee when a
 * quote on the same claim flips to payment_status='succeeded' (job
 * completed with an OtterQuote contractor). Idempotent. Rebate amount is
 * read per-order from hover_orders.homeowner_charge_amount — no code
 * change needed when the charge amount changes.
 *
 * Two invocation modes:
 *   POST { claim_id }   — process rebate for a specific claim on demand.
 *   POST {} (or { scan: true })
 *                       — scan all hover_orders with rebate_due=true AND
 *                         rebate_paid_at IS NULL AND a quote exists with
 *                         payment_status='succeeded' for that claim.
 *                         Designed to be invoked by pg_cron.
 *
 * Rules:
 *   - Only issues a refund if the associated hover_orders row has
 *     rebate_due=true AND rebate_paid_at IS NULL AND
 *     homeowner_stripe_payment_intent_id IS NOT NULL.
 *   - On success: sets rebate_paid_at=now(), rebate_due=false.
 *   - On Stripe error: leaves rebate_due=true for retry, logs to activity_log.
 *   - Never double-refunds (idempotency guard on rebate_paid_at).
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   STRIPE_SECRET_KEY
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "process-hover-rebate";
const STRIPE_API_BASE = "https://api.stripe.com/v1";

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

interface RebateResult {
  claim_id: string;
  hover_order_id: string;
  status: "rebated" | "skipped" | "failed";
  detail?: string;
  refund_id?: string;
  amount?: number;
}

/**
 * Process a single hover_orders row into a Stripe refund if it qualifies.
 * Returns a RebateResult describing what happened.
 */
async function rebateOne(
  supabase: any,
  stripeSecretKey: string,
  order: any,
): Promise<RebateResult> {
  const base: RebateResult = {
    claim_id: order.claim_id,
    hover_order_id: order.id,
    status: "skipped",
  };

  // Guards (defensive; the caller's query already filters for these).
  if (order.rebate_paid_at) {
    return { ...base, detail: "Already rebated." };
  }
  if (!order.rebate_due) {
    return { ...base, detail: "rebate_due is false." };
  }
  if (!order.homeowner_stripe_payment_intent_id) {
    return { ...base, detail: "No payment_intent_id recorded; cannot refund." };
  }
  if (!order.homeowner_charge_amount || order.homeowner_charge_amount <= 0) {
    return { ...base, detail: "No homeowner_charge_amount recorded; cannot refund." };
  }

  // Confirm a completed quote exists on this claim (payment_status='succeeded').
  // This is the canonical "job completed" signal — matches v40 after_quote_paid.
  const { data: completedQuotes, error: qErr } = await supabase
    .from("quotes")
    .select("id, payment_status")
    .eq("claim_id", order.claim_id)
    .eq("payment_status", "succeeded")
    .limit(1);
  if (qErr) {
    return { ...base, status: "failed", detail: `Quote lookup failed: ${qErr.message}` };
  }
  if (!completedQuotes || completedQuotes.length === 0) {
    return { ...base, detail: "No completed quote on claim yet; rebate not owed." };
  }

  // Stripe refund — idempotency key prevents double refund on retry.
  const basicAuth = btoa(`${stripeSecretKey}:`);
  const form = new URLSearchParams();
  form.append("payment_intent", order.homeowner_stripe_payment_intent_id);
  form.append("amount", String(order.homeowner_charge_amount));
  form.append("reason", "requested_by_customer");
  form.append("metadata[type]", "hover_measurement_rebate");
  form.append("metadata[claim_id]", order.claim_id);
  form.append("metadata[hover_order_id]", order.id);

  const idempotencyKey = `hover_rebate_${order.id}`;
  const refundRes = await fetch(`${STRIPE_API_BASE}/refunds`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body: form.toString(),
  });

  if (!refundRes.ok) {
    const err = await refundRes.text();
    console.error("[rebate] Stripe refund failed:", order.id, refundRes.status, err);
    // Log to activity_log for visibility; leave rebate_due=true for retry.
    try {
      await supabase.from("activity_log").insert({
        action: "hover_rebate_failed",
        metadata: {
          hover_order_id: order.id,
          claim_id: order.claim_id,
          stripe_status: refundRes.status,
          stripe_error: err,
        },
      });
    } catch { /* non-fatal */ }
    return { ...base, status: "failed", detail: `Stripe refund error (HTTP ${refundRes.status}): ${err}` };
  }

  const refund = await refundRes.json();

  // Mark rebated — idempotent via rebate_paid_at guard on the update.
  const { error: updErr } = await supabase
    .from("hover_orders")
    .update({
      rebate_due: false,
      rebate_paid_at: new Date().toISOString(),
    })
    .eq("id", order.id)
    .is("rebate_paid_at", null); // idempotency: only flip if still unpaid
  if (updErr) {
    console.error("[rebate] DB update after refund failed:", order.id, updErr);
    // Refund already happened — log but do not fail the call (refund is real).
    try {
      await supabase.from("activity_log").insert({
        action: "hover_rebate_db_update_failed",
        metadata: {
          hover_order_id: order.id,
          claim_id: order.claim_id,
          stripe_refund_id: refund.id,
          db_error: updErr.message,
        },
      });
    } catch { /* non-fatal */ }
  }

  console.log("[rebate] Rebated order", order.id, "refund:", refund.id, "amount:", order.homeowner_charge_amount);
  return {
    ...base,
    status: "rebated",
    refund_id: refund.id,
    amount: order.homeowner_charge_amount,
  };
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) {
    return new Response(JSON.stringify({ error: "Stripe secret key not configured." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch { /* empty body — treat as scan */ }

  // Health check ping.
  if (body?.health_check === true) {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
    });
  }

  const { claim_id, scan } = body ?? {};
  const isScan = scan === true || (!claim_id);

  try {
    if (claim_id && !isScan) {
      // Single-claim mode
      const { data: orders, error: orderErr } = await supabase
        .from("hover_orders")
        .select("id, claim_id, homeowner_stripe_payment_intent_id, homeowner_charge_amount, rebate_due, rebate_paid_at")
        .eq("claim_id", claim_id)
        .eq("rebate_due", true)
        .is("rebate_paid_at", null);
      if (orderErr) throw new Error(`Order lookup failed: ${orderErr.message}`);

      const results: RebateResult[] = [];
      for (const order of orders ?? []) {
        results.push(await rebateOne(supabase, stripeSecretKey, order));
      }
      return new Response(JSON.stringify({ mode: "single", claim_id, processed: results.length, results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Scan mode: all rebate-eligible orders where a matching completed quote exists.
    const { data: pending, error: pErr } = await supabase
      .from("hover_orders")
      .select("id, claim_id, homeowner_stripe_payment_intent_id, homeowner_charge_amount, rebate_due, rebate_paid_at")
      .eq("rebate_due", true)
      .is("rebate_paid_at", null)
      .not("homeowner_stripe_payment_intent_id", "is", null)
      .limit(100); // safety cap per run
    if (pErr) throw new Error(`Scan lookup failed: ${pErr.message}`);

    const results: RebateResult[] = [];
    for (const order of pending ?? []) {
      results.push(await rebateOne(supabase, stripeSecretKey, order));
    }
    const rebated = results.filter(r => r.status === "rebated").length;
    const failed = results.filter(r => r.status === "failed").length;
    const skipped = results.filter(r => r.status === "skipped").length;
    return new Response(JSON.stringify({
      mode: "scan",
      scanned: results.length,
      rebated,
      failed,
      skipped,
      results,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error: any) {
    console.error(`[${FUNCTION_NAME}] error:`, error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
