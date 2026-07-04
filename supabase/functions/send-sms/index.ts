/**
 * OtterQuote Edge Function: send-sms
 * Sends SMS messages via Twilio.
 * Rate-limited via Supabase check_rate_limit() RPC.
 *
 * Rate limits (D-063 spending controls):
 * 20/day, 100/month
 *
 * Environment variables:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_MESSAGING_SERVICE_SID   ← preferred (A2P / TCR campaign)
 *   TWILIO_PHONE_NUMBER             ← fallback only if messaging service not set
 *
 * ── Auth (D-211 Phase 16/32 — open-relay closure) ─────────────────────────
 * verify_jwt=false at the gateway (preserved) so trusted internal callers
 * (notify-contractors uses the service-role bearer) and logged-in browser
 * callers both work. Authorization is enforced IN-HANDLER: the caller must
 * present EITHER the service-role key OR a valid authenticated-user JWT
 * (auth.getUser). Anonymous / anon-key-only / missing-token callers are
 * rejected — this closes the prior unauthenticated open-relay (86e207gey).
 * NOTE: for authenticated end-user callers the recipient is still caller-
 * supplied; claim-scoped recipient derivation (selected contractor + claimant)
 * is deferred to the SMS re-enablement work, gated behind the Twilio A2P/TCR
 * vendor remediation. Tracked — do not ship user-facing SMS live without it.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "send-sms";

// CORS tightened Apr 15, 2026 (Session 181, ClickUp 86e0xhz2j): sensitive
// function (SMS send) — origin allowlisted instead of wildcard.
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

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // ── AUTH GATE (D-211 Phase 32 — close the open SMS relay, 86e207gey) ────
    // Require EITHER the service-role key (trusted internal callers, e.g.
    // notify-contractors) OR a valid authenticated-user JWT. Reject anyone
    // presenting no token or only the public anon key.
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    let isAuthorized = false;
    if (token && token === supabaseKey) {
      isAuthorized = true; // trusted internal caller (service role)
    } else if (token) {
      const { data: userData } = await supabase.auth.getUser(token);
      if (userData?.user) isAuthorized = true; // authenticated end user
    }

    if (!isAuthorized) {
      console.warn(`[${FUNCTION_NAME}] Unauthorized call rejected (no valid user/service token).`);
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { to, message, notification_id } = await req.json();

    // Validate required fields
    if (!to || !message) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: to, message",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Defensive sanitization of the caller-supplied message (D-211 Phase 32):
    // strip C0 control characters (keep \t \n \r) and clamp length (~10 SMS
    // segments) to limit content-injection / oversized-send abuse.
    const safeMessage = String(message)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
      .slice(0, 1600);

    // ========== RATE LIMIT CHECK ==========
    const { data: rateLimitResult, error: rlError } = await supabase.rpc(
      "check_rate_limit",
      {
        p_function_name: FUNCTION_NAME,
        p_user_id: null,
      }
    );

    if (rlError) {
      console.error("Rate limit check failed:", rlError);
      return new Response(
        JSON.stringify({
          error:
            "Rate limit check failed. Refusing to send SMS for safety.",
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

    // ========== GET TWILIO CREDENTIALS ==========
    const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
    const TWILIO_MESSAGING_SERVICE_SID = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID");
    const TWILIO_PHONE_NUMBER = Deno.env.get("TWILIO_PHONE_NUMBER");

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      throw new Error(
        "Twilio credentials not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN."
      );
    }

    if (!TWILIO_MESSAGING_SERVICE_SID && !TWILIO_PHONE_NUMBER) {
      throw new Error(
        "No Twilio sender configured. Set TWILIO_MESSAGING_SERVICE_SID (preferred) or TWILIO_PHONE_NUMBER."
      );
    }

    // ========== SEND SMS ==========
    const basicAuth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);

    const formData = new URLSearchParams();
    formData.append("To", to);
    formData.append("Body", safeMessage);

    // Use Messaging Service SID for A2P / TCR compliance when available.
    // Fall back to a direct phone number only if the SID is not configured.
    if (TWILIO_MESSAGING_SERVICE_SID) {
      formData.append("MessagingServiceSid", TWILIO_MESSAGING_SERVICE_SID);
      console.log("Sending SMS via MessagingServiceSid to:", to);
    } else {
      formData.append("From", TWILIO_PHONE_NUMBER!);
      console.log("Sending SMS via phone number to:", to, "from:", TWILIO_PHONE_NUMBER);
    }

    const twilioResponse = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData,
      }
    );

    if (!twilioResponse.ok) {
      const errorData = await twilioResponse.text();
      console.error(
        "Twilio SMS send failed:",
        twilioResponse.status,
        errorData
      );
      throw new Error(
        `Twilio API error (HTTP ${twilioResponse.status}): ${errorData}`
      );
    }

    const twilioData = await twilioResponse.json();
    /*
     * twilioData shape:
     * {
     *   sid: "SM...",
     *   account_sid: "AC...",
     *   to: "+13175551234",
     *   from: "+18448753412",
     *   body: "...",
     *   status: "queued",
     *   date_created: "...",
     *   ...
     * }
     */

    console.log("SMS sent successfully. SID:", twilioData.sid);

    return new Response(
      JSON.stringify({
        sid: twilioData.sid,
        status: "sent",
        to: twilioData.to,
        rate_limit_counts: rateLimitResult?.counts,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("send-sms error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
