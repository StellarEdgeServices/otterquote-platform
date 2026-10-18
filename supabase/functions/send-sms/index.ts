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
 * ── Auth (D-211 Phase 16/32, tightened by gh-1916) ────────────────────────
 * verify_jwt=false at the gateway (preserved) so trusted internal callers
 * (notify-contractors, process-dunning, send-contractor-nudge use the
 * service-role bearer) reach the handler. Authorization is enforced IN-HANDLER
 * and is SERVICE-ROLE ONLY: the relay takes a caller-supplied recipient, so a
 * logged-in end user must not be able to text any number through the A2P
 * campaign. No token / anon key / invalid token -> 401; a valid end-user JWT
 * -> 403; the service-role key -> proceeds. (Before gh-1916 any authenticated
 * user JWT was accepted; no app code relied on that: the only browser caller,
 * services.sendAdjusterFollowup, has no call sites and already treats an
 * error as "not sent".)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { authorizeServiceOnly, resolveTwilioSender } from "./sender-selection.ts";

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
    // ── AUTH GATE (gh-1916: service-role only; see the header) ──────────────
    const authHeader = req.headers.get("Authorization") || "";
    const authDecision = await authorizeServiceOnly(
      authHeader,
      supabaseKey,
      async (token) => {
        const { data: userData } = await supabase.auth.getUser(token);
        return userData;
      },
    );

    if (!authDecision.ok) {
      console.warn(`[${FUNCTION_NAME}] Call rejected (${authDecision.status}): not a service-role caller.`);
      return new Response(
        JSON.stringify({ error: authDecision.error }),
        {
          status: authDecision.status,
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

    // Sender selection (which Twilio field to populate) is resolved by the
    // pure, unit-tested resolveTwilioSender (./sender-selection.ts) — it
    // throws the same "No Twilio sender configured" error as before when
    // neither TWILIO_MESSAGING_SERVICE_SID nor TWILIO_PHONE_NUMBER is usably
    // set (whitespace-only values now count as unset; see gh-1843).
    const senderField = resolveTwilioSender({
      messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID,
      phoneNumber: TWILIO_PHONE_NUMBER,
    });

    // ========== SEND SMS ==========
    const basicAuth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);

    const formData = new URLSearchParams();
    formData.append("To", to);
    formData.append("Body", safeMessage);
    formData.append(senderField.field, senderField.value);
    console.log(
      senderField.field === "MessagingServiceSid"
        ? `Sending SMS via MessagingServiceSid to: ${to}`
        : `Sending SMS via phone number to: ${to} from: ${senderField.value}`
    );

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

    // ── Log the SID (gh-1825) ────────────────────────────────────────────
    // This function reports "sent" on Twilio's initial API acceptance only
    // and never reads the final carrier delivery status — recorded here so
    // platform-health-check's Phase 4 (sms-delivery-status-check) has a
    // durable trail of what we sent, independent of its own direct Twilio
    // poll. Best-effort and non-blocking: a logging failure must never
    // become a second failure on top of an already-sent message, so this
    // is wrapped and never awaited-into-the-response. No user_id is
    // available for service-role-triggered sends (e.g. notify-contractors),
    // so the system-placeholder UUID already used elsewhere for the same
    // reason (see stripe-webhook/index.ts) is used here too. Phone number
    // is truncated to the last 4 digits — the SID and Twilio remain the
    // source of truth for the full number.
    try {
      const { error: logErr } = await supabase.from("activity_log").insert({
        user_id: "00000000-0000-0000-0000-000000000000",
        event_type: "sms_sent",
        title: "sms_sent",
        metadata: {
          sid: twilioData.sid,
          to_last4: String(to).slice(-4),
          status: "sent",
          notification_id: notification_id ?? null,
        },
      });
      if (logErr) {
        console.error(`[${FUNCTION_NAME}] activity_log insert failed:`, logErr.message);
      }
    } catch (logErr) {
      console.error(`[${FUNCTION_NAME}] activity_log write threw:`, logErr);
    }

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
