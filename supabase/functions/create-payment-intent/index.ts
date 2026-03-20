/**
 * ClaimShield Edge Function: create-payment-intent
 * Creates a Stripe PaymentIntent for Hover fees or deductible escrow.
 * Rate-limited via Supabase check_rate_limit() RPC.
 *
 * Environment variables:
 *   STRIPE_SECRET_KEY
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "create-payment-intent";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { amount, currency, description, metadata } = await req.json();

    if (!amount || amount < 50) {
      return new Response(
        JSON.stringify({ error: "Amount must be at least 50 cents" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Hard cap: refuse any single payment intent over $10,000 (sanity check)
    if (amount > 1000000) { // Stripe uses cents
      return new Response(
        JSON.stringify({ error: "Amount exceeds maximum allowed ($10,000). Contact support." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ========== RATE LIMIT CHECK ==========
    const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_caller_id: metadata?.claim_id || null,
    });

    if (rlError) {
      console.error("Rate limit check failed:", rlError);
      return new Response(
        JSON.stringify({ error: "Rate limit check failed. Refusing to process for safety.", detail: rlError.message }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!rateLimitResult?.allowed) {
      console.warn(`RATE LIMITED [${FUNCTION_NAME}]: ${rateLimitResult?.reason}`);
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded",
          reason: rateLimitResult?.reason,
          counts: rateLimitResult?.counts,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // ========== END RATE LIMIT CHECK ==========

    const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    if (!STRIPE_SECRET_KEY) {
      throw new Error("Stripe secret key not configured.");
    }

    // Create PaymentIntent via Stripe API
    const params = new URLSearchParams({
      amount: String(amount),
      currency: currency || "usd",
      description: description || "ClaimShield payment",
      "automatic_payment_methods[enabled]": "true",
    });

    // Add metadata
    if (metadata) {
      for (const [key, value] of Object.entries(metadata)) {
        params.append(`metadata[${key}]`, String(value));
      }
    }

    const response = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(`Stripe error: ${result.error?.message || JSON.stringify(result)}`);
    }

    return new Response(
      JSON.stringify({
        client_secret: result.client_secret,
        payment_intent_id: result.id,
        amount: result.amount,
        status: result.status,
        rate_limit_counts: rateLimitResult?.counts,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("create-payment-intent error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
