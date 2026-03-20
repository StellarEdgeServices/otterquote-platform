/**
 * ClaimShield Edge Function: send-adjuster-email
 * Sends email to adjuster via Mailgun requesting insurance documents.
 * Sets reply-to to a unique ingest address for auto-capture of replies.
 * Rate-limited via Supabase check_rate_limit() RPC.
 *
 * Environment variables:
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *   MAILGUN_FROM_NAME  (default: "ClaimShield")
 *   MAILGUN_FROM_EMAIL (default: "noreply@{MAILGUN_DOMAIN}")
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "send-adjuster-email";

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
    const { to, to_name, subject, body, reply_to, request_id, claim_id } = await req.json();

    if (!to || !subject || !body) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: to, subject, body" }),
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

    const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
    const MAILGUN_DOMAIN = Deno.env.get("MAILGUN_DOMAIN");
    const FROM_NAME = Deno.env.get("MAILGUN_FROM_NAME") || "ClaimShield";
    const FROM_EMAIL = Deno.env.get("MAILGUN_FROM_EMAIL") || `noreply@${MAILGUN_DOMAIN}`;

    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      throw new Error("Mailgun credentials not configured. Set MAILGUN_API_KEY and MAILGUN_DOMAIN in Edge Function secrets.");
    }

    // Build form data for Mailgun API
    const formData = new FormData();
    formData.append("from", `${FROM_NAME} <${FROM_EMAIL}>`);
    formData.append("to", to_name ? `${to_name} <${to}>` : to);
    formData.append("subject", subject);
    formData.append("text", body);

    // Set reply-to to the unique ingest email so adjuster replies are captured
    if (reply_to) {
      formData.append("h:Reply-To", reply_to);
    }

    // Send via Mailgun
    const response = await fetch(
      `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`api:${MAILGUN_API_KEY}`)}`,
        },
        body: formData,
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(`Mailgun error: ${JSON.stringify(result)}`);
    }

    // Update the request record with sent status
    if (request_id) {
      await supabase
        .from("adjuster_email_requests")
        .update({
          sent_at: new Date().toISOString(),
          mailgun_message_id: result.id,
        })
        .eq("id", request_id);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message_id: result.id,
        rate_limit_counts: rateLimitResult?.counts,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("send-adjuster-email error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
