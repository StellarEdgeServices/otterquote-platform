/**
 * OtterQuote Edge Function: create-payment-intent
 * Creates a Stripe PaymentIntent for three use cases:
 *   - Hover measurement purchases (~$49)
 *   - Deductible escrow
 *   - Contractor platform fees (5% of job value)
 *
 * Multi-payment-method support (v2):
 *   - For platform_fee charges, tries payment methods from contractor_payment_methods table
 *   - Priority: default method first, then ACH methods, then card methods
 *   - ACH charges: exact platform fee (no surcharge)
 *   - Card charges: adds processing fee on top (2.9% + $0.30)
 *   - Records which payment method was used on the quote record
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

// CORS tightened Apr 15, 2026 (Session 181, ClickUp 86e0xhz2j): payment
// intent creation is high-sensitivity — origin allowlisted instead of wildcard.
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

/**
 * Calculate the total amount to charge when using a credit card,
 * so that after Stripe takes its 2.9% + $0.30, we receive the full platform fee.
 *
 * Formula: charge_amount = (platform_fee + 0.30) / (1 - 0.029)
 * All amounts in cents.
 */
function calculateCardChargeAmount(platformFeeCents: number): number {
  const chargeAmount = Math.ceil((platformFeeCents + 30) / (1 - 0.029));
  return chargeAmount;
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Health check ping -- returns immediately without doing real work.
  // Called by platform-health-check every 15 minutes.
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
    const {
      amount,
      currency,
      description,
      metadata,
      contractor_id,
      off_session,
    } = await req.json();

    // Validate required fields
    if (
      !amount ||
      typeof amount !== "number" ||
      amount <= 0 ||
      !Number.isInteger(amount)
    ) {
      return new Response(
        JSON.stringify({
          error: "Invalid amount. Must be a positive integer (in cents).",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!currency || typeof currency !== "string") {
      return new Response(
        JSON.stringify({
          error: "Invalid currency. Must be a string (e.g., 'usd').",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!metadata || !metadata.claim_id || !metadata.type) {
      return new Response(
        JSON.stringify({
          error:
            "Missing required metadata fields: claim_id and type (hover_measurement, deductible_escrow, or platform_fee).",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const validTypes = ["hover_measurement", "deductible_escrow", "platform_fee"];
    if (!validTypes.includes(metadata.type)) {
      return new Response(
        JSON.stringify({
          error: `Invalid metadata.type. Must be one of: ${validTypes.join(", ")}`,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // For platform_fee type, contractor_id and off_session are required
    if (metadata.type === "platform_fee" && off_session) {
      if (!contractor_id) {
        return new Response(
          JSON.stringify({
            error:
              "Missing contractor_id for off-session platform fee charge.",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    // ========== RATE LIMIT CHECK ==========
    const { data: rateLimitResult, error: rlError } = await supabase.rpc(
      "check_rate_limit",
      {
        p_function_name: FUNCTION_NAME,
        p_caller_id: metadata.claim_id || null,
      }
    );

    if (rlError) {
      console.error("Rate limit check failed:", rlError);
      return new Response(
        JSON.stringify({
          error:
            "Rate limit check failed. Refusing to create payment intent for safety.",
          detail: rlError.message,
        }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!rateLimitResult?.allowed) {
      console.warn(
        `RATE LIMITED [${FUNCTION_NAME}]: ${rateLimitResult?.reason}`
      );
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded",
          reason: rateLimitResult?.reason,
          counts: rateLimitResult?.counts,
        }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ========== GET STRIPE SECRET KEY ==========
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");

    if (!stripeSecretKey) {
      throw new Error(
        "Stripe secret key not configured. Set STRIPE_SECRET_KEY environment variable."
      );
    }

    const basicAuth = btoa(`${stripeSecretKey}:`);

    // ========== HANDLE OFF-SESSION CHARGING (Contractor Platform Fees) ==========
    let paymentIntentData;

    if (metadata.type === "platform_fee" && off_session && contractor_id) {
      // Look up contractor's Stripe customer ID
      const { data: contractorData, error: contractorError } = await supabase
        .from("contractors")
        .select("stripe_customer_id, stripe_payment_method_id")
        .eq("id", contractor_id)
        .single();

      if (contractorError || !contractorData) {
        throw new Error(
          `Failed to look up contractor: ${
            contractorError?.message || "contractor not found"
          }`
        );
      }

      if (!contractorData.stripe_customer_id) {
        throw new Error(
          "Contractor does not have a Stripe customer on file. Charge cannot proceed."
        );
      }

      // Fetch all payment methods from the new table, ordered: default first, then ACH, then cards
      const { data: paymentMethods, error: pmError } = await supabase
        .from("contractor_payment_methods")
        .select("*")
        .eq("contractor_id", contractor_id)
        .order("is_default", { ascending: false })
        .order("payment_type", { ascending: true }); // 'card' before 'us_bank_account' alphabetically — we re-sort below

      if (pmError) {
        console.error("Error fetching payment methods:", pmError);
      }

      // Build the ordered list of methods to try:
      // 1. Default method first
      // 2. ACH methods (free for contractor)
      // 3. Card methods (processing fee applies)
      // Fallback: legacy stripe_payment_method_id if no methods in new table
      interface PaymentMethodAttempt {
        stripe_payment_method_id: string;
        payment_type: string;
        id: string | null; // contractor_payment_methods.id (null for legacy fallback)
      }

      const methodsToTry: PaymentMethodAttempt[] = [];

      if (paymentMethods && paymentMethods.length > 0) {
        // Default first
        const defaultMethod = paymentMethods.find(m => m.is_default);
        const nonDefault = paymentMethods.filter(m => !m.is_default);

        // Sort non-default: ACH first (cheaper), then cards
        const achMethods = nonDefault.filter(m => m.payment_type === "us_bank_account");
        const cardMethods = nonDefault.filter(m => m.payment_type === "card");

        if (defaultMethod) {
          methodsToTry.push({
            stripe_payment_method_id: defaultMethod.stripe_payment_method_id,
            payment_type: defaultMethod.payment_type,
            id: defaultMethod.id,
          });
        }

        // Add remaining ACH methods
        for (const m of achMethods) {
          if (!defaultMethod || m.id !== defaultMethod.id) {
            methodsToTry.push({
              stripe_payment_method_id: m.stripe_payment_method_id,
              payment_type: m.payment_type,
              id: m.id,
            });
          }
        }

        // Add remaining card methods
        for (const m of cardMethods) {
          if (!defaultMethod || m.id !== defaultMethod.id) {
            methodsToTry.push({
              stripe_payment_method_id: m.stripe_payment_method_id,
              payment_type: m.payment_type,
              id: m.id,
            });
          }
        }
      } else if (contractorData.stripe_payment_method_id) {
        // Legacy fallback: single payment method on contractors table
        methodsToTry.push({
          stripe_payment_method_id: contractorData.stripe_payment_method_id,
          payment_type: "card", // legacy was always card
          id: null,
        });
      }

      if (methodsToTry.length === 0) {
        throw new Error(
          "Contractor does not have any payment methods on file. Charge cannot proceed."
        );
      }

      console.log(
        "Creating off-session PaymentIntent for contractor",
        contractor_id,
        "platform_fee:",
        amount,
        currency,
        "methods_to_try:",
        methodsToTry.length
      );

      // Try each payment method in order until one succeeds
      let lastError = "";
      let usedMethod: PaymentMethodAttempt | null = null;
      let chargedAmount = amount; // the actual amount charged (may include card fee)
      let cardFeeCents = 0;

      for (const method of methodsToTry) {
        // Calculate charge amount based on payment type
        let thisChargeAmount = amount;
        let thisCardFee = 0;

        if (method.payment_type === "card") {
          // Card: add processing fee on top so we net the full platform fee
          thisChargeAmount = calculateCardChargeAmount(amount);
          thisCardFee = thisChargeAmount - amount;
          console.log(
            `Card method ${method.stripe_payment_method_id}: platform_fee=${amount}, card_fee=${thisCardFee}, total_charge=${thisChargeAmount}`
          );
        } else {
          // ACH: charge exact platform fee (no surcharge)
          console.log(
            `ACH method ${method.stripe_payment_method_id}: platform_fee=${amount}, no surcharge`
          );
        }

        const offSessionFormData = new URLSearchParams();
        offSessionFormData.append("amount", String(thisChargeAmount));
        offSessionFormData.append("currency", currency);
        offSessionFormData.append("customer", contractorData.stripe_customer_id);
        offSessionFormData.append("payment_method", method.stripe_payment_method_id);
        offSessionFormData.append("off_session", "true");
        offSessionFormData.append("confirm", "true");
        offSessionFormData.append("description", description || "");
        offSessionFormData.append("metadata[claim_id]", metadata.claim_id);
        offSessionFormData.append("metadata[type]", metadata.type);
        offSessionFormData.append("metadata[contractor_id]", contractor_id);
        offSessionFormData.append("metadata[payment_type]", method.payment_type);
        offSessionFormData.append("metadata[platform_fee_cents]", String(amount));
        if (thisCardFee > 0) {
          offSessionFormData.append("metadata[card_fee_cents]", String(thisCardFee));
        }

        // For ACH: specify payment method type explicitly
        if (method.payment_type === "us_bank_account") {
          offSessionFormData.append("payment_method_types[]", "us_bank_account");
        } else {
          offSessionFormData.append("payment_method_types[]", "card");
        }

        try {
          const offSessionResponse = await fetch(
            `${STRIPE_API_BASE}/payment_intents`,
            {
              method: "POST",
              headers: {
                Authorization: `Basic ${basicAuth}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: offSessionFormData.toString(),
            }
          );

          const responseData = await offSessionResponse.json();

          if (!offSessionResponse.ok) {
            lastError = responseData?.error?.message || `HTTP ${offSessionResponse.status}`;
            console.warn(
              `Payment method ${method.stripe_payment_method_id} (${method.payment_type}) failed:`,
              lastError
            );
            continue; // Try next method
          }

          // Check for statuses that indicate the payment didn't go through
          if (responseData.status === "requires_action" || responseData.status === "requires_payment_method") {
            lastError = `Payment ${responseData.status} for method ${method.stripe_payment_method_id}`;
            console.warn(lastError);

            // Cancel this failed intent so it doesn't linger
            try {
              await fetch(`${STRIPE_API_BASE}/payment_intents/${responseData.id}/cancel`, {
                method: "POST",
                headers: {
                  Authorization: `Basic ${basicAuth}`,
                  "Content-Type": "application/x-www-form-urlencoded",
                },
              });
            } catch (cancelErr) {
              console.warn("Failed to cancel stuck PaymentIntent:", cancelErr);
            }

            continue; // Try next method
          }

          // Success!
          paymentIntentData = responseData;
          usedMethod = method;
          chargedAmount = thisChargeAmount;
          cardFeeCents = thisCardFee;
          console.log(
            `Payment succeeded with method ${method.stripe_payment_method_id} (${method.payment_type}). Status:`,
            responseData.status
          );
          break;

        } catch (fetchErr) {
          lastError = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          console.warn(
            `Payment attempt error for method ${method.stripe_payment_method_id}:`,
            lastError
          );
          continue;
        }
      }

      // If no method succeeded, throw with details
      if (!paymentIntentData) {
        const failedMethodsSummary = methodsToTry.map(m =>
          `${m.payment_type} (****${m.stripe_payment_method_id.slice(-4)})`
        ).join(", ");
        throw new Error(
          `All ${methodsToTry.length} payment methods failed. Tried: ${failedMethodsSummary}. Last error: ${lastError}`
        );
      }

      // Record payment result on the quote — payment_status + payment_intent_id
      // are required to fire the v40 commission trigger (AFTER UPDATE OF payment_status).
      if (metadata.quote_id || metadata.claim_id) {
        // ACH (us_bank_account) returns Stripe status 'processing' — authorized but
        // not yet settled (3-5 business days). Map to 'succeeded' in our DB because
        // (a) the DB constraint quotes_payment_status_check does not include 'processing',
        // and (b) for contractor platform fees, ACH authorization = commitment to pay.
        const dbPaymentStatus = paymentIntentData.status === "processing"
          ? "succeeded"
          : paymentIntentData.status;
        const quoteUpdate: Record<string, any> = {
          payment_method_type: usedMethod!.payment_type,
          payment_status: dbPaymentStatus,
          payment_intent_id: paymentIntentData.id,
        };
        if (usedMethod!.id) {
          quoteUpdate.payment_method_id = usedMethod!.id;
        }
        if (cardFeeCents > 0) {
          quoteUpdate.card_fee_cents = cardFeeCents;
        }

        // Update the quote if we have a quote_id in metadata
        if (metadata.quote_id) {
          await supabase
            .from("quotes")
            .update(quoteUpdate)
            .eq("id", metadata.quote_id);
        }
      }

      console.log(
        "Off-session PaymentIntent status:",
        paymentIntentData.status,
        "ID:",
        paymentIntentData.id,
        "Method type:",
        usedMethod!.payment_type,
        "Charged:",
        chargedAmount,
        "Card fee:",
        cardFeeCents
      );
    } else {
      // ========== CREATE PAYMENT INTENT (Standard flow for homeowner/measurement fees) ==========
      // Build URL-encoded form data
      const formData = new URLSearchParams();
      formData.append("amount", String(amount));
      formData.append("currency", currency);
      formData.append("description", description || "");
      formData.append("metadata[claim_id]", metadata.claim_id);
      formData.append("metadata[type]", metadata.type);
      formData.append("automatic_payment_methods[enabled]", "true");

      console.log(
        "Creating Stripe PaymentIntent for",
        metadata.type,
        "claim:",
        metadata.claim_id,
        "amount:",
        amount,
        currency
      );

      const paymentIntentResponse = await fetch(
        `${STRIPE_API_BASE}/payment_intents`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${basicAuth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData.toString(),
        }
      );

      if (!paymentIntentResponse.ok) {
        const errorData = await paymentIntentResponse.text();
        console.error(
          "Stripe PaymentIntent creation failed:",
          paymentIntentResponse.status,
          errorData
        );
        throw new Error(
          `Stripe API error (HTTP ${paymentIntentResponse.status}): ${errorData}`
        );
      }

      paymentIntentData = await paymentIntentResponse.json();
    }

    console.log(
      "Stripe PaymentIntent created/confirmed. ID:",
      paymentIntentData.id,
      "Status:",
      paymentIntentData.status
    );

    // For off-session charges, success status is 'succeeded' or 'processing'
    // For standard intents awaiting client action, status is 'requires_payment_method'
    const successStatuses = ["succeeded", "processing"];
    const isSuccessful = successStatuses.includes(paymentIntentData.status);

    return new Response(
      JSON.stringify({
        client_secret: paymentIntentData.client_secret || null,
        payment_intent_id: paymentIntentData.id,
        status: paymentIntentData.status,
        succeeded: isSuccessful,
        amount: paymentIntentData.amount,
        currency: paymentIntentData.currency,
        rate_limit_counts: rateLimitResult?.counts,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("create-payment-intent error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
