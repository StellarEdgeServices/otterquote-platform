/**
 * OtterQuote Edge Function: create-hover-order
 * Creates a Hover capture request (measurement order) via the v2 API.
 * Uses OAuth tokens stored in hover_tokens table (auto-refreshes if expired).
 * Rate-limited via Supabase check_rate_limit() RPC.
 *
 * THIS IS THE MOST EXPENSIVE METERED CALL (~$25-40 per order).
 * Hard-capped at 2/day, 10/month.
 *
 * Environment variables:
 *   HOVER_CLIENT_ID
 *   HOVER_CLIENT_SECRET
 *   HOVER_REDIRECT_URI
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "create-hover-order";
const HOVER_API_BASE = "https://hover.to";

// CORS tightened (Session 254): origin-allowlisted instead of wildcard.
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
 * Get a valid Hover access token, refreshing if expired.
 */
async function getValidAccessToken(
  supabase: any,
  clientId: string,
  clientSecret: string
): Promise<string> {
  // Get the stored token
  const { data: tokens, error } = await supabase
    .from("hover_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error || !tokens || tokens.length === 0) {
    throw new Error(
      "No Hover OAuth tokens found. Connect Hover first via hover-oauth-init."
    );
  }

  const token = tokens[0];
  const expiresAt = new Date(token.expires_at);
  const now = new Date();

  // If token is still valid (with 5-minute buffer), use it
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
    return token.access_token;
  }

  // Token expired or about to expire — refresh it
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
    throw new Error(
      `Hover token refresh failed (HTTP ${refreshResponse.status}). Re-authorize via hover-oauth-init.`
    );
  }

  const newTokenData = await refreshResponse.json();

  const newExpiresAt = new Date(
    Date.now() + (newTokenData.expires_in || 7200) * 1000
  ).toISOString();

  // Update the token in the database
  const { error: updateError } = await supabase
    .from("hover_tokens")
    .update({
      access_token: newTokenData.access_token,
      refresh_token: newTokenData.refresh_token || token.refresh_token,
      expires_at: newExpiresAt,
      scope: newTokenData.scope || token.scope,
    })
    .eq("id", token.id);

  if (updateError) {
    console.error("Failed to update refreshed token:", updateError);
  }

  console.log("Hover token refreshed. New expiry:", newExpiresAt);
  return newTokenData.access_token;
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

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
      deliverable_type_id = 2, // Default: Roof Only
    } = await req.json();

    // Validate required fields
    if (!order_id || !address_line_1 || !homeowner_email || !homeowner_name) {
      return new Response(
        JSON.stringify({
          error:
            "Missing required fields: order_id, address_line_1, homeowner_email, homeowner_name",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ========== DUPLICATE CHECK ==========
    const { data: existingOrders } = await supabase
      .from("hover_orders")
      .select("id, status")
      .eq("address", address_line_1)
      .in("status", [
        "pending",
        "link_sent",
        "photos_submitted",
        "processing",
        "complete",
      ])
      .limit(1);

    if (existingOrders && existingOrders.length > 0) {
      return new Response(
        JSON.stringify({
          error: "Duplicate order prevented",
          reason: `An active Hover order already exists for this address (order ${existingOrders[0].id}, status: ${existingOrders[0].status}).`,
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ========== RATE LIMIT CHECK ==========
    const { data: rateLimitResult, error: rlError } = await supabase.rpc(
      "check_rate_limit",
      {
        p_function_name: FUNCTION_NAME,
        p_caller_id: claim_id || null,
      }
    );

    if (rlError) {
      console.error("Rate limit check failed:", rlError);
      return new Response(
        JSON.stringify({
          error:
            "Rate limit check failed. Refusing to create order for safety.",
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
          estimated_spend: rateLimitResult?.estimated_spend,
        }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ========== GET OAUTH TOKEN ==========
    const HOVER_CLIENT_ID = Deno.env.get("HOVER_CLIENT_ID")!;
    const HOVER_CLIENT_SECRET = Deno.env.get("HOVER_CLIENT_SECRET")!;

    if (!HOVER_CLIENT_ID || !HOVER_CLIENT_SECRET) {
      throw new Error(
        "Hover OAuth credentials not configured. Set HOVER_CLIENT_ID and HOVER_CLIENT_SECRET."
      );
    }

    const accessToken = await getValidAccessToken(
      supabase,
      HOVER_CLIENT_ID,
      HOVER_CLIENT_SECRET
    );

    // ========== CREATE CAPTURE REQUEST ==========
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

    console.log(
      "Creating Hover capture request for:",
      address_line_1,
      "deliverable:",
      deliverable_type_id
    );

    const captureResponse = await fetch(
      `${HOVER_API_BASE}/api/v2/capture_requests`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(captureRequestBody),
      }
    );

    if (!captureResponse.ok) {
      const errorData = await captureResponse.text();
      console.error(
        "Hover capture request failed:",
        captureResponse.status,
        errorData
      );
      throw new Error(
        `Hover API error (HTTP ${captureResponse.status}): ${errorData}`
      );
    }

    const captureData = await captureResponse.json();
    /*
     * captureData shape:
     * {
     *   id: 12345,
     *   identifier: "xpod232",
     *   state: "new",
     *   pending_job_id: 67890,
     *   capturing_user_email: "...",
     *   ...
     * }
     */

    // Build the capture link URL
    const captureLink = `${HOVER_API_BASE}/api/v2/capture_requests/${captureData.identifier}`;

    // ========== UPDATE OUR DATABASE ==========
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
      })
      .eq("id", order_id);

    if (updateError) {
      console.error("Failed to update hover_orders:", updateError);
      // Non-fatal — the capture request was created on Hover's side
    }

    console.log(
      "Hover capture request created. ID:",
      captureData.id,
      "Identifier:",
      captureData.identifier,
      "Job:",
      captureData.pending_job_id
    );

    return new Response(
      JSON.stringify({
        capture_request_id: captureData.id,
        identifier: captureData.identifier,
        capture_link: captureLink,
        pending_job_id: captureData.pending_job_id,
        state: captureData.state,
        rate_limit_counts: rateLimitResult?.counts,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("create-hover-order error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
