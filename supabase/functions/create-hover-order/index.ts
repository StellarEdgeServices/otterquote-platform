/**
 * OtterQuote Edge Function: create-hover-order
 * Creates a Hover capture request (measurement order) via the v2 API.
 * Uses OAuth tokens stored in hover_tokens table (auto-refreshes if expired).
 * Rate-limited via Supabase check_rate_limit() RPC.
 *
 * D-181 (Apr 23, 2026, ClickUp 86e117ty3) amended by D-205 (May 2, 2026):
 * Before ordering Hover, verifies that the homeowner's Stripe PaymentIntent
 * for the Hover measurement fee is in status='succeeded'. If payment has
 * not succeeded, returns 402 without contacting Hover. On success, persists
 * payment_intent_id + charged amount + rebate_due=true on the hover_orders
 * row.
 *
 * D-205 (May 2, 2026): deliverable_type_id is now REQUIRED on the request
 * body — no silent default. Allowed values: 2 (Roof Only) or 3 (Complete).
 * Frontend always sends 3 for full-replacement jobs per the universal
 * Hover Complete + $150 model. Fails loud with HTTP 400 if missing or
 * invalid.
 *
 * THIS IS THE MOST EXPENSIVE METERED CALL (~$25-40 per order).
 * Hard-capped at 2/day, 10/month via rate_limit_config.
 *
 * Environment variables:
 *   HOVER_CLIENT_ID
 *   HOVER_CLIENT_SECRET
 *   STRIPE_SECRET_KEY
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "create-hover-order";
const HOVER_API_BASE = "https://hover.to";
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

async function getValidAccessToken(supabase: any, clientId: string, clientSecret: string): Promise<string> {
  const { data: tokens, error } = await supabase
    .from("hover_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !tokens || tokens.length === 0) {
    throw new Error("No Hover OAuth tokens found. Connect Hover first via hover-oauth-init.");
  }
  const token = tokens[0];
  const expiresAt = new Date(token.expires_at);
  if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) return token.access_token;

  console.log("Hover access token expired, refreshing...");
  const refreshResponse = await fetch(`${HOVER_API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token.refresh_token,
    }),
  });
  if (!refreshResponse.ok) {
    const errText = await refreshResponse.text();
    console.error("Token refresh failed:", refreshResponse.status, errText);
    throw new Error(`Hover token refresh failed (HTTP ${refreshResponse.status}). Re-authorize via hover-oauth-init.`);
  }
  const newTokenData = await refreshResponse.json();
  const newExpiresAt = new Date(Date.now() + (newTokenData.expires_in || 7200) * 1000).toISOString();
  await supabase.from("hover_tokens").update({
    access_token: newTokenData.access_token,
    refresh_token: newTokenData.refresh_token || token.refresh_token,
    expires_at: newExpiresAt,
    scope: newTokenData.scope || token.scope,
  }).eq("id", token.id);
  return newTokenData.access_token;
}

/**
 * D-181: Verify the homeowner's Stripe PaymentIntent is 'succeeded' and
 * matches the expected amount from platform_settings before creating the
 * Hover order. Returns { ok: true, amount } on success, { ok: false, ... }
 * otherwise. Never contacts Hover if the guard fails.
 */
async function verifyHoverPayment(
  supabase: any,
  paymentIntentId: string,
  claimId: string | null,
): Promise<{ ok: true; amount: number } | { ok: false; status: number; error: string }> {
  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) {
    return { ok: false, status: 500, error: "Stripe secret key not configured." };
  }

  // Look up expected price (defensive default 15000 — D-205, $150).
  const { data: priceRow } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", "hover_measurement_price")
    .maybeSingle();
  const expectedAmount = typeof priceRow?.value === "number"
    ? priceRow.value
    : Number(priceRow?.value ?? 15000);

  const basicAuth = btoa(`${stripeSecretKey}:`);
  const piRes = await fetch(`${STRIPE_API_BASE}/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
    headers: { Authorization: `Basic ${basicAuth}` },
  });
  if (!piRes.ok) {
    const errText = await piRes.text();
    console.error("Stripe PI retrieve failed:", piRes.status, errText);
    return { ok: false, status: 402, error: "Payment record not found. We could not verify your Hover measurement payment. Please try again or contact support." };
  }
  const pi = await piRes.json();

  if (pi.status !== "succeeded") {
    return { ok: false, status: 402, error: `Payment must complete before we can order your Hover measurements. Current payment status: ${pi.status}.` };
  }
  if (pi.amount !== expectedAmount) {
    console.error("PI amount mismatch:", { got: pi.amount, expected: expectedAmount, pi: pi.id });
    return { ok: false, status: 402, error: "Payment amount does not match the expected Hover fee. Please contact support." };
  }
  if (claimId && pi.metadata?.claim_id && pi.metadata.claim_id !== claimId) {
    console.error("PI claim_id mismatch:", { pi_claim: pi.metadata.claim_id, supplied: claimId });
    return { ok: false, status: 402, error: "Payment does not belong to this claim. Please contact support." };
  }
  if (pi.metadata?.type && pi.metadata.type !== "hover_measurement") {
    console.error("PI type mismatch:", { pi_type: pi.metadata.type });
    return { ok: false, status: 402, error: "Payment is not a Hover measurement charge. Please contact support." };
  }
  return { ok: true, amount: pi.amount };
}


/**
 * Verify the incoming JWT using Supabase Auth.
 * --no-verify-jwt bypasses the gateway (ES256/HS256 mismatch).
 * This handler-level check closes that gap for authenticated callers.
 * Returns { user } on success, or a ready-to-return 401 Response on failure.
 */
async function verifyJwt(
  req: Request,
  supabaseUrl: string,
  supabaseAnonKey: string,
  corsHeaders: Record<string, string>,
): Promise<{ user: any } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({ error: "Unauthorized. A valid user session is required." }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const jwt = authHeader.slice(7);
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) {
    return new Response(
      JSON.stringify({ error: "Unauthorized. Session invalid or expired." }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  return { user };
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // ===== JWT VERIFICATION =====
  // Gateway JWT check disabled (--no-verify-jwt) due to ES256/HS256 mismatch.
  // Manual verification here closes the unauthenticated-caller gap.
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const jwtResult = await verifyJwt(req, supabaseUrl, supabaseAnonKey, corsHeaders);
  if (jwtResult instanceof Response) return jwtResult;
  const { user: authedUser } = jwtResult; // v57: extract user for per-user rate limiting

  try {
    const {
      order_id,
      claim_id,
      address_line_1,
      address_city,
      address_state,
      address_zip,
      homeowner_name,
      homeowner_email,
      homeowner_phone,
      deliverable_type_id, // D-205: REQUIRED — no silent default
      payment_intent_id,   // D-181: required
    } = await req.json();

    // Validate required fields
    if (!order_id || !address_line_1 || !homeowner_email || !homeowner_name) {
      return new Response(JSON.stringify({
        error: "Missing required fields: order_id, address_line_1, homeowner_email, homeowner_name",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!payment_intent_id || typeof payment_intent_id !== "string") {
      return new Response(JSON.stringify({
        error: "Missing payment_intent_id. A completed Stripe payment is required before ordering Hover measurements (D-181).",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    // D-205: deliverable_type_id is required and must be in the allowed set.
    // 2 = Roof Only (legacy / repair scenarios). 3 = Complete (D-205 universal default for full-replacement jobs).
    // Never silently default — every caller must pass an explicit value.
    if (deliverable_type_id !== 2 && deliverable_type_id !== 3) {
      return new Response(JSON.stringify({
        error: "Missing or invalid deliverable_type_id. Per D-205, this must be explicitly passed by the caller and must be 2 (Roof Only) or 3 (Complete). Frontend should send 3 for all full-replacement jobs.",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ===== IDEMPOTENCY =====
    // If a hover_orders row already exists with this payment_intent_id AND the
    // Hover capture_request_id is populated, return that existing order rather
    // than double-ordering (Stripe retries, network blips, etc.).
    const { data: existingByPi } = await supabase
      .from("hover_orders")
      .select("id, capture_request_id, capture_request_identifier, capture_link, hover_job_id, status, rebate_due")
      .eq("homeowner_stripe_payment_intent_id", payment_intent_id)
      .maybeSingle();
    if (existingByPi && existingByPi.capture_request_id) {
      console.log("[idempotent] Hover order already exists for PI:", payment_intent_id);
      return new Response(JSON.stringify({
        capture_request_id: existingByPi.capture_request_id,
        identifier: existingByPi.capture_request_identifier,
        capture_link: existingByPi.capture_link,
        pending_job_id: existingByPi.hover_job_id,
        state: existingByPi.status,
        idempotent: true,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ===== DUPLICATE CHECK (by address) =====
    const { data: existingOrders } = await supabase
      .from("hover_orders")
      .select("id, status")
      .eq("address", address_line_1)
      .in("status", ["pending", "link_sent", "photos_submitted", "processing", "complete"])
      .limit(1);
    if (existingOrders && existingOrders.length > 0 && existingOrders[0].id !== order_id) {
      return new Response(JSON.stringify({
        error: "Duplicate order prevented",
        reason: `An active Hover order already exists for this address (order ${existingOrders[0].id}, status: ${existingOrders[0].status}).`,
      }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ===== D-181 PAYMENT VERIFICATION GUARD =====
    const paymentCheck = await verifyHoverPayment(supabase, payment_intent_id, claim_id || null);
    if (!paymentCheck.ok) {
      console.warn("[D-181] Payment verification failed for order", order_id, ":", paymentCheck.error);
      return new Response(JSON.stringify({ error: paymentCheck.error }), {
        status: paymentCheck.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const verifiedAmount = paymentCheck.amount;

    // ===== RATE LIMIT =====
    const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_user_id: authedUser?.id || null,
    });
    if (rlError) {
      console.error("Rate limit check failed:", rlError);
      return new Response(JSON.stringify({
        error: "Rate limit check failed. Refusing to create order for safety.",
        detail: rlError.message,
      }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!rateLimitResult?.allowed) {
      console.warn(`RATE LIMITED [${FUNCTION_NAME}]: ${rateLimitResult?.reason}`);
      return new Response(JSON.stringify({
        error: "Rate limit exceeded",
        reason: rateLimitResult?.reason,
        counts: rateLimitResult?.counts,
        estimated_spend: rateLimitResult?.estimated_spend,
      }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ===== HOVER OAUTH =====
    const HOVER_CLIENT_ID = Deno.env.get("HOVER_CLIENT_ID")!;
    const HOVER_CLIENT_SECRET = Deno.env.get("HOVER_CLIENT_SECRET")!;
    if (!HOVER_CLIENT_ID || !HOVER_CLIENT_SECRET) {
      throw new Error("Hover OAuth credentials not configured.");
    }
    const accessToken = await getValidAccessToken(supabase, HOVER_CLIENT_ID, HOVER_CLIENT_SECRET);

    // ===== CREATE CAPTURE REQUEST =====
    const captureRequestBody = {
      capture_request: {
        capturing_user_email: homeowner_email,
        capturing_user_phone: homeowner_phone || undefined,
        capturing_user_name: homeowner_name,
        signup_type: "homeowner",
        job_attributes: {
          location_line_1: address_line_1,
          location_city: address_city || undefined,
          location_region: address_state || undefined,
          location_postal_code: address_zip || undefined,
          name: `OtterQuote - ${address_line_1}`,
          deliverable_id: String(deliverable_type_id),
          external_identifier: claim_id || order_id,
        },
      },
      current_user_email: Deno.env.get("HOVER_USER_EMAIL") || undefined,
    };

    console.log("Creating Hover capture request for:", address_line_1, "deliverable:", deliverable_type_id);
    const captureResponse = await fetch(`${HOVER_API_BASE}/api/v2/capture_requests`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(captureRequestBody),
    });
    if (!captureResponse.ok) {
      const errorData = await captureResponse.text();
      console.error("Hover capture request failed:", captureResponse.status, errorData);
      throw new Error(`Hover API error (HTTP ${captureResponse.status}): ${errorData}`);
    }
    const captureData = await captureResponse.json();
    const captureLink = `${HOVER_API_BASE}/api/v2/capture_requests/${captureData.identifier}`;

    // ===== PERSIST to hover_orders =====
    // D-181: store payment_intent_id, amount charged, and flip rebate_due=true.
    const { error: updateError } = await supabase
      .from("hover_orders")
      .update({
        hover_job_id: captureData.pending_job_id || null,
        capture_request_id: captureData.id,
        capture_request_identifier: captureData.identifier,
        capture_link: captureLink,
        hover_link: captureLink,
        status: "link_sent",
        deliverable_type_id: deliverable_type_id,
        capturing_user_email: homeowner_email,
        capturing_user_phone: homeowner_phone || null,
        homeowner_stripe_payment_intent_id: payment_intent_id,
        homeowner_charge_amount: verifiedAmount,
        rebate_due: true,
      })
      .eq("id", order_id);
    if (updateError) {
      console.error("Failed to update hover_orders:", updateError);
      // Non-fatal — the capture request was created on Hover's side.
    }

    console.log("Hover capture request created. ID:", captureData.id, "Identifier:", captureData.identifier);

    return new Response(JSON.stringify({
      capture_request_id: captureData.id,
      identifier: captureData.identifier,
      capture_link: captureLink,
      pending_job_id: captureData.pending_job_id,
      state: captureData.state,
      rate_limit_counts: rateLimitResult?.counts,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error: any) {
    console.error("create-hover-order error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
