/**
 * OtterQuote Edge Function: send-adjuster-email
 * Sends email requests for insurance documents to adjusters via Mailgun.
 * Rate-limited via Supabase check_rate_limit() RPC.
 *
 * Limits: 10/day, 50/month
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "send-adjuster-email";

// CORS tightened Apr 15, 2026 (Session 181, ClickUp 86e0xhz2j): sensitive
// function (outbound email with adjuster/claim context) — origin allowlisted.
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

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { to, to_name, subject, body, reply_to, request_id } =
      await req.json();

    // Validate required fields
    if (!to || !subject || !body) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: to, subject, body",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ========== RATE LIMIT CHECK ==========
    const { data: rateLimitResult, error: rlError } = await supabase.rpc(
      "check_rate_limit",
      {
        p_function_name: FUNCTION_NAME,
        p_caller_id: request_id || null,
      }
    );

    if (rlError) {
      console.error("Rate limit check failed:", rlError);
      return new Response(
        JSON.stringify({
          error: "Rate limit check failed. Refusing to send email for safety.",
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

    // ========== VALIDATE MAILGUN ENV VARS ==========
    const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
    const MAILGUN_DOMAIN = Deno.env.get("MAILGUN_DOMAIN");

    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      throw new Error(
        "Mailgun credentials not configured. Set MAILGUN_API_KEY and MAILGUN_DOMAIN."
      );
    }

    // ========== SEND EMAIL VIA MAILGUN ==========
    const fromAddress = `OtterQuote <noreply@${MAILGUN_DOMAIN}>`;

    // Build URL-encoded form data for Mailgun
    const formData = new URLSearchParams();
    formData.append("from", fromAddress);
    formData.append("to", to_name ? `${to_name} <${to}>` : to);
    formData.append("subject", subject);
    formData.append("text", body);
    if (reply_to) {
      formData.append("h:Reply-To", reply_to);
    }

    console.log("Sending Mailgun email to:", to, "subject:", subject);

    const mailgunResponse = await fetch(
      `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`api:${MAILGUN_API_KEY}`)}`,
        },
        body: formData,
      }
    );

    if (!mailgunResponse.ok) {
      const errorData = await mailgunResponse.text();
      console.error(
        "Mailgun request failed:",
        mailgunResponse.status,
        errorData
      );
      throw new Error(
        `Mailgun API error (HTTP ${mailgunResponse.status}): ${errorData}`
      );
    }

    const responseData = await mailgunResponse.json();
    /*
     * responseData shape:
     * {
     *   id: "<12345678901234567890abcdef@mail.otterquote.com>",
     *   message: "Queued. Thank you."
     * }
     */

    // ========== UPDATE ADJUSTER_EMAIL_REQUESTS TABLE ==========
    if (request_id) {
      const { error: updateError } = await supabase
        .from("adjuster_email_requests")
        .update({
          sent_at: new Date().toISOString(),
          mailgun_id: responseData.id,
        })
        .eq("id", request_id);

      if (updateError) {
        console.error(
          "Failed to update adjuster_email_requests:",
          updateError
        );
        // Non-fatal — the email was sent on Mailgun's side
      }
    }

    console.log(
      "Email sent to:",
      to,
      "Mailgun ID:",
      responseData.id,
      "Request ID:",
      request_id
    );

    return new Response(
      JSON.stringify({
        id: responseData.id,
        status: "sent",
        to: to,
        rate_limit_counts: rateLimitResult?.counts,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("send-adjuster-email error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
