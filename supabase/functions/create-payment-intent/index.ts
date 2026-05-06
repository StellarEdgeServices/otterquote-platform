/**
 * OtterQuote Edge Function: create-payment-intent
 * Creates a Stripe PaymentIntent for three use cases:
 *   - Hover measurement purchases ($79 — D-181, server-side priced from platform_settings)
 *   - Deductible escrow
 *   - Contractor platform fees (5% of job value)
 *
 * D-181 (Apr 23, 2026, ClickUp 86e117ty3): For hover_measurement charges the
 * amount is read server-side from platform_settings.hover_measurement_price.
 * Client-sent amount is ignored for that branch (Deploy Review Checklist #25 —
 * amount validated server-side). All other branches unchanged.
 *
 * Multi-payment-method support (platform_fee branch):
 *   - Default method first, then ACH, then cards
 *   - ACH charges: exact platform fee (no surcharge)
 *   - Card charges: 2.9% + $0.30 passthrough so we net the full fee
 *
 * Rate-limited via Supabase check_rate_limit() RPC.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   STRIPE_SECRET_KEY
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "create-payment-intent";
const STRIPE_API_BASE = "https://api.stripe.com/v1";

// CORS tightened Apr 15, 2026 (Session 181): payment intent creation is
// high-sensitivity — origin allowlisted instead of wildcard.
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

/**
 * charge_amount = (platform_fee + 0.30) / (1 - 0.029). All in cents.
 */
function calculateCardChargeAmount(platformFeeCents: number): number {
  return Math.ceil((platformFeeCents + 30) / (1 - 0.029));
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Health check ping — used by platform-health-check every 15 minutes.
  try {
    const bodyPeek = await req.clone().json().catch(() => ({}));
    if (bodyPeek?.health_check === true) {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }
  } catch { /* no-op */ }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { amount: clientAmount, currency, description, metadata, contractor_id, off_session } = await req.json();

    // D-181: server-side price enforcement for hover_measurement.
    let amount: number = clientAmount;
    if (metadata?.type === "hover_measurement") {
      const { data: priceRow, error: priceErr } = await supabase
        .from("platform_settings")
        .select("value")
        .eq("key", "hover_measurement_price")
        .maybeSingle();
      if (priceErr) {
        console.error("Failed to read hover_measurement_price:", priceErr);
        return new Response(JSON.stringify({
          error: "Could not read Hover price from platform_settings.",
          detail: priceErr.message,
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      // platform_settings.value is JSONB — a raw number lands as a number.
      // Default 7900 cents if unset (migration v54 seeds it).
      const resolvedPrice = typeof priceRow?.value === "number"
        ? priceRow.value
        : Number(priceRow?.value ?? 7900);
      if (!Number.isFinite(resolvedPrice) || resolvedPrice <= 0 || !Number.isInteger(resolvedPrice)) {
        return new Response(JSON.stringify({
          error: "platform_settings.hover_measurement_price is not a valid positive integer (cents).",
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      amount = resolvedPrice;
      console.log("[hover_measurement] Server-side price enforced:", amount, "(client sent:", clientAmount, ")");
    }

    if (!amount || typeof amount !== "number" || amount <= 0 || !Number.isInteger(amount)) {
      return new Response(JSON.stringify({ error: "Invalid amount. Must be a positive integer (in cents)." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!currency || typeof currency !== "string") {
      return new Response(JSON.stringify({ error: "Invalid currency. Must be a string (e.g., 'usd')." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!metadata || !metadata.claim_id || !metadata.type) {
      return new Response(JSON.stringify({
        error: "Missing required metadata fields: claim_id and type (hover_measurement, deductible_escrow, or platform_fee).",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const validTypes = ["hover_measurement", "deductible_escrow", "platform_fee"];
    if (!validTypes.includes(metadata.type)) {
      return new Response(JSON.stringify({ error: `Invalid metadata.type. Must be one of: ${validTypes.join(", ")}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (metadata.type === "platform_fee" && off_session && !contractor_id) {
      return new Response(JSON.stringify({ error: "Missing contractor_id for off-session platform fee charge." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ===== RATE LIMIT =====
    const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_user_id: null,  // repo version: no JWT auth in handler; anonymous bucket applies
    });
    if (rlError) {
      console.error("Rate limit check failed:", rlError);
      return new Response(JSON.stringify({
        error: "Rate limit check failed. Refusing to create payment intent for safety.",
        detail: rlError.message,
      }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!rateLimitResult?.allowed) {
      console.warn(`RATE LIMITED [${FUNCTION_NAME}]: ${rateLimitResult?.reason}`);
      return new Response(JSON.stringify({
        error: "Rate limit exceeded",
        reason: rateLimitResult?.reason,
        counts: rateLimitResult?.counts,
      }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) throw new Error("Stripe secret key not configured.");
    const basicAuth = btoa(`${stripeSecretKey}:`);

    let paymentIntentData: any;

    // ===== OFF-SESSION contractor platform fee =====
    if (metadata.type === "platform_fee" && off_session && contractor_id) {
      const { data: contractorData, error: contractorError } = await supabase
        .from("contractors")
        .select("stripe_customer_id, stripe_payment_method_id")
        .eq("id", contractor_id)
        .single();
      if (contractorError || !contractorData) {
        throw new Error(`Failed to look up contractor: ${contractorError?.message || "contractor not found"}`);
      }
      if (!contractorData.stripe_customer_id) {
        throw new Error("Contractor does not have a Stripe customer on file. Charge cannot proceed.");
      }

      const { data: paymentMethods } = await supabase
        .from("contractor_payment_methods")
        .select("*")
        .eq("contractor_id", contractor_id)
        .order("is_default", { ascending: false })
        .order("payment_type", { ascending: true });

      interface PaymentMethodAttempt { stripe_payment_method_id: string; payment_type: string; id: string | null; }
      const methodsToTry: PaymentMethodAttempt[] = [];
      if (paymentMethods && paymentMethods.length > 0) {
        const defaultMethod = paymentMethods.find((m: any) => m.is_default);
        const nonDefault = paymentMethods.filter((m: any) => !m.is_default);
        const achMethods = nonDefault.filter((m: any) => m.payment_type === "us_bank_account");
        const cardMethods = nonDefault.filter((m: any) => m.payment_type === "card");
        if (defaultMethod) {
          methodsToTry.push({
            stripe_payment_method_id: defaultMethod.stripe_payment_method_id,
            payment_type: defaultMethod.payment_type,
            id: defaultMethod.id,
          });
        }
        for (const m of achMethods) {
          if (!defaultMethod || m.id !== defaultMethod.id) {
            methodsToTry.push({ stripe_payment_method_id: m.stripe_payment_method_id, payment_type: m.payment_type, id: m.id });
          }
        }
        for (const m of cardMethods) {
          if (!defaultMethod || m.id !== defaultMethod.id) {
            methodsToTry.push({ stripe_payment_method_id: m.stripe_payment_method_id, payment_type: m.payment_type, id: m.id });
          }
        }
      } else if (contractorData.stripe_payment_method_id) {
        methodsToTry.push({ stripe_payment_method_id: contractorData.stripe_payment_method_id, payment_type: "card", id: null });
      }
      if (methodsToTry.length === 0) {
        throw new Error("Contractor does not have any payment methods on file. Charge cannot proceed.");
      }

      let lastError = "";
      let usedMethod: PaymentMethodAttempt | null = null;
      let chargedAmount = amount;
      let cardFeeCents = 0;
      for (const method of methodsToTry) {
        let thisChargeAmount = amount;
        let thisCardFee = 0;
        if (method.payment_type === "card") {
          thisChargeAmount = calculateCardChargeAmount(amount);
          thisCardFee = thisChargeAmount - amount;
        }
        const form = new URLSearchParams();
        form.append("amount", String(thisChargeAmount));
        form.append("currency", currency);
        form.append("customer", contractorData.stripe_customer_id);
        form.append("payment_method", method.stripe_payment_method_id);
        form.append("off_session", "true");
        form.append("confirm", "true");
        form.append("description", description || "");
        form.append("metadata[claim_id]", metadata.claim_id);
        form.append("metadata[type]", metadata.type);
        form.append("metadata[contractor_id]", contractor_id);
        form.append("metadata[payment_type]", method.payment_type);
        form.append("metadata[platform_fee_cents]", String(amount));
        if (thisCardFee > 0) form.append("metadata[card_fee_cents]", String(thisCardFee));
        form.append("payment_method_types[]", method.payment_type === "us_bank_account" ? "us_bank_account" : "card");
        try {
          const r = await fetch(`${STRIPE_API_BASE}/payment_intents`, {
            method: "POST",
            headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString(),
          });
          const rd = await r.json();
          if (!r.ok) { lastError = rd?.error?.message || `HTTP ${r.status}`; continue; }
          if (rd.status === "requires_action" || rd.status === "requires_payment_method") {
            lastError = `Payment ${rd.status} for method ${method.stripe_payment_method_id}`;
            try {
              await fetch(`${STRIPE_API_BASE}/payment_intents/${rd.id}/cancel`, {
                method: "POST",
                headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
              });
            } catch {}
            continue;
          }
          paymentIntentData = rd;
          usedMethod = method;
          chargedAmount = thisChargeAmount;
          cardFeeCents = thisCardFee;
          break;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          continue;
        }
      }
      if (!paymentIntentData) {
        throw new Error(`All ${methodsToTry.length} payment methods failed. Last error: ${lastError}`);
      }
      if (metadata.quote_id) {
        const dbPaymentStatus = paymentIntentData.status === "processing" ? "succeeded" : paymentIntentData.status;
        const quoteUpdate: Record<string, any> = {
          payment_method_type: usedMethod!.payment_type,
          payment_status: dbPaymentStatus,
          payment_intent_id: paymentIntentData.id,
        };
        if (usedMethod!.id) quoteUpdate.payment_method_id = usedMethod!.id;
        if (cardFeeCents > 0) quoteUpdate.card_fee_cents = cardFeeCents;
        await supabase.from("quotes").update(quoteUpdate).eq("id", metadata.quote_id);
      }
    } else {
      // ===== Standard flow (hover_measurement, deductible_escrow) =====
      const form = new URLSearchParams();
      form.append("amount", String(amount));
      form.append("currency", currency);
      form.append("description", description || "");
      form.append("metadata[claim_id]", metadata.claim_id);
      form.append("metadata[type]", metadata.type);
      form.append("automatic_payment_methods[enabled]", "true");
      const r = await fetch(`${STRIPE_API_BASE}/payment_intents`, {
        method: "POST",
        headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (!r.ok) {
        const err = await r.text();
        throw new Error(`Stripe API error (HTTP ${r.status}): ${err}`);
      }
      paymentIntentData = await r.json();
    }

    const isSuccessful = ["succeeded", "processing"].includes(paymentIntentData.status);
    return new Response(JSON.stringify({
      client_secret: paymentIntentData.client_secret || null,
      payment_intent_id: paymentIntentData.id,
      status: paymentIntentData.status,
      succeeded: isSuccessful,
      amount: paymentIntentData.amount,
      currency: paymentIntentData.currency,
      rate_limit_counts: rateLimitResult?.counts,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error: any) {
    console.error("create-payment-intent error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         