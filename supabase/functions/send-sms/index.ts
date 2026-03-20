/**
 * ClaimShield Edge Function: send-sms
 * Sends SMS notifications via Twilio.
 * Rate-limited via Supabase check_rate_limit() RPC.
 *
 * Environment variables:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_PHONE_NUMBER (E.164 format, e.g., +13175551234)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "send-sms";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Initialize Supabase client (needed for rate limiting and notification updates)
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { to, message, notification_id, claim_id } = await req.json();

    if (!to || !message) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: to, message" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ========== RATE LIMIT CHECK ==========
    const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_caller_id: claim_id || null,
    });

    if (rlError) {
      console.error("Rate limit check failed:", rlError);
      // Fail closed — if we can't verify the rate limit, don't send
      return new Response(
        JSON.stringify({ error: "Rate limit check failed. Refusing to send for safety.", detail: rlError.message }),
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

    const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
    const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
    const TWILIO_PHONE = Deno.env.get("TWILIO_PHONE_NUMBER");

    if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_PHONE) {
      throw new Error("Twilio credentials not configured.");
    }

    // Send via Twilio REST API
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
    const formBody = new URLSearchParams({
      To: to,
      From: TWILIO_PHONE,
      Body: message,
    });

    const response = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody.toString(),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(`Twilio error: ${result.message || JSON.stringify(result)}`);
    }

    // Update notification record
    if (notification_id) {
      await supabase
        .from("notifications")
        .update({
          delivered: true,
          twilio_sid: result.sid,
          delivered_at: new Date().toISOString(),
        })
        .eq("id", notification_id);
    }

    return new Response(
      JSON.stringify({
        success: true,
        sid: result.sid,
        rate_limit_counts: rateLimitResult?.counts,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("send-sms error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
