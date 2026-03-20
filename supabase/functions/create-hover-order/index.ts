/**
 * ClaimShield Edge Function: create-hover-order
 * Creates a Hover measurement job and returns the photo capture link.
 * Rate-limited via Supabase check_rate_limit() RPC.
 *
 * THIS IS THE MOST EXPENSIVE METERED CALL (~$25-40 per order).
 * Hard-capped at 2/day, 10/month.
 *
 * Environment variables:
 *   HOVER_API_KEY
 *   HOVER_API_URL (default: https://api.hover.to/v1)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "create-hover-order";

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
    const { order_id, address, claim_id } = await req.json();

    if (!order_id || !address) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: order_id, address" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ========== DUPLICATE CHECK ==========
    // Prevent duplicate Hover orders for the same address (expensive!)
    const { data: existingOrders } = await supabase
      .from("hover_orders")
      .select("id, status")
      .eq("address", address)
      .in("status", ["pending", "link_sent", "photos_submitted", "processing", "complete"])
      .limit(1);

    if (existingOrders && existingOrders.length > 0) {
      return new Response(
        JSON.stringify({
          error: "Duplicate order prevented",
          reason: `An active Hover order already exists for this address (order ${existingOrders[0].id}, status: ${existingOrders[0].status}).`,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // ========== END DUPLICATE CHECK ==========

    // ========== RATE LIMIT CHECK ==========
    const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_caller_id: claim_id || null,
    });

    if (rlError) {
      console.error("Rate limit check failed:", rlError);
      return new Response(
        JSON.stringify({ error: "Rate limit check failed. Refusing to create order for safety.", detail: rlError.message }),
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
          estimated_spend: rateLimitResult?.estimated_spend,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // ========== END RATE LIMIT CHECK ==========

    const HOVER_API_KEY = Deno.env.get("HOVER_API_KEY");
    const HOVER_API_URL = Deno.env.get("HOVER_API_URL") || "https://api.hover.to/v1";

    if (!HOVER_API_KEY) {
      throw new Error("Hover API key not configured. Apply for partner access at developers.hover.to");
    }

    // Create Hover job via API
    const hoverResponse = await fetch(`${HOVER_API_URL}/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HOVER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        address: address,
        deliverable_types: ["measurements", "3d_model"],
        reference_id: order_id,
        metadata: {
          claim_id: claim_id,
          platform: "claimshield",
        },
      }),
    });

    if (!hoverResponse.ok) {
      const errorData = await hoverResponse.json();
      throw new Error(`Hover API error: ${JSON.stringify(errorData)}`);
    }

    const hoverData = await hoverResponse.json();

    // Update the order in our database
    await supabase
      .from("hover_orders")
      .update({
        hover_job_id: hoverData.id || hoverData.job_id,
        hover_link: hoverData.capture_url || hoverData.capture_link,
        status: "link_sent",
      })
      .eq("id", order_id);

    return new Response(
      JSON.stringify({
        job_id: hoverData.id || hoverData.job_id,
        capture_link: hoverData.capture_url || hoverData.capture_link,
        rate_limit_counts: rateLimitResult?.counts,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("create-hover-order error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
