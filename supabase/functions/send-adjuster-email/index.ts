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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

const FUNCTION_NAME = "send-adjuster-email";

// CORS tightened Apr 15, 2026 (Session 181, ClickUp 86e0xhz2j): sensitive
// function (outbound email with adjuster/claim context) — origin allowlisted.
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

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/**
 * HTML counterpart of the outbound adjuster email (gh-1013). `bodyText` is
 * homeowner-authored free text sent to an external insurance adjuster — this
 * adds structure only (escaped, line breaks preserved, existing URLs turned
 * into clickable anchors), never new wording. The text/plain part above
 * keeps any URL bare, per #869 AC 2.
 */
function adjusterEmailHtml(bodyText: string): string {
  const escaped = escapeHtml(bodyText);
  const linked = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" style="color:#0EA5E9;">${url}</a>`
  );
  const withBreaks = linked.replace(/\n/g, "<br>");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#0F172A;">
            ${withBreaks}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
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
    const { subject, body, request_id } = await req.json();

    // Validate required fields. request_id is now REQUIRED — the recipient is
    // derived from the adjuster_email_requests row it identifies, never from a
    // caller-supplied `to` (which was the open-relay vector). (D-211 P19 Unit 5)
    if (!request_id || !subject || !body) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: request_id, subject, body",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // ========== AUTH (mirror parse-loss-sheet dual pattern) ==========
    // verify_jwt=false; enforce in-code. Trusted service-role callers bypass
    // ownership; user-JWT callers must own the claim behind request_id.
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const isServiceRole = token === supabaseKey;
    let callerId: string | null = null;

    if (!isServiceRole) {
      if (!token) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const { data: { user: caller }, error: authErr } =
        await supabase.auth.getUser(token);
      if (authErr || !caller) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: invalid token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      callerId = caller.id;
    }

    // ========== BIND RECIPIENT TO THE CLAIM'S ADJUSTER ==========
    // recipient / name / reply-to come from the stored adjuster_email_requests
    // row (written by the homeowner flow), NOT from the request body. This is
    // what closes the open relay.
    const { data: reqRow, error: reqErr } = await supabase
      .from("adjuster_email_requests")
      .select("id, claim_id, to_email, to_name, ingest_email")
      .eq("id", request_id)
      .single();

    if (reqErr || !reqRow) {
      return new Response(
        JSON.stringify({ error: "Adjuster email request not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Claim lookup: needed both for the ownership check (user-JWT callers)
    // and to resolve the homeowner's email for Reply-To (gh-1625 item 2 —
    // service-role callers need it too, so this now runs unconditionally).
    const { data: claimRow, error: claimErr } = await supabase
      .from("claims")
      .select("user_id")
      .eq("id", reqRow.claim_id)
      .single();

    if (!isServiceRole) {
      if (claimErr || !claimRow || claimRow.user_id !== callerId) {
        return new Response(
          JSON.stringify({ error: "Forbidden: caller does not own this claim" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Derive + sanitize. Reject a stored address containing separators so it
    // cannot fan out to additional recipients via the display-name field.
    const recipient = String(reqRow.to_email || "").trim();
    if (!recipient || /[\s,<>"]/.test(recipient)) {
      return new Response(
        JSON.stringify({ error: "No valid adjuster email on file for this request" }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const recipientName = String(reqRow.to_name || "").replace(/[\r\n<>,"]+/g, " ").trim();

    // Reply-To (gh-1625 item 2): the message body tells the adjuster replies
    // go straight to the homeowner, so Reply-To must actually point there —
    // not at our ingest address, which contradicted the body and falsified
    // the published disclaimer that Otter Quotes does not handle insurer
    // communications. Resolve the homeowner's email from their claim
    // (profiles row, falling back to auth — same pattern as
    // send-homeowner-next-steps) rather than from reqRow.ingest_email.
    let replyTo = "";
    if (claimRow?.user_id) {
      const { data: homeownerProfile } = await supabase
        .from("profiles")
        .select("email")
        .eq("id", claimRow.user_id)
        .maybeSingle();
      let homeownerEmail = homeownerProfile?.email || null;
      if (!homeownerEmail) {
        const { data: authUser } = await supabase.auth.admin.getUserById(claimRow.user_id);
        homeownerEmail = authUser?.user?.email || null;
      }
      replyTo = String(homeownerEmail || "").replace(/[\r\n]+/g, "").trim();
    }
    if (!replyTo) {
      console.warn(
        `[${FUNCTION_NAME}] No homeowner email resolved for claim ${reqRow.claim_id} — sending without Reply-To`
      );
    }

    // ========== RATE LIMIT CHECK (per-user; null => global bucket for service-role) ==========
    const { data: rateLimitResult, error: rlError } = await supabase.rpc(
      "check_rate_limit",
      {
        p_function_name: FUNCTION_NAME,
        p_user_id: callerId,
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
    const fromAddress = `Otter Quotes <noreply@${MAILGUN_DOMAIN}>`;

    // Build URL-encoded form data for Mailgun
    const formData = new URLSearchParams();
    formData.append("from", fromAddress);
    formData.append("to", recipientName ? `${recipientName} <${recipient}>` : recipient);
    formData.append("subject", subject);
    formData.append("text", body);
    formData.append("html", adjusterEmailHtml(body));
    if (replyTo) {
      formData.append("h:Reply-To", replyTo);
    }

    console.log("Sending Mailgun email to:", recipient, "subject:", subject);

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
      recipient,
      "Mailgun ID:",
      responseData.id,
      "Request ID:",
      request_id
    );

    return new Response(
      JSON.stringify({
        id: responseData.id,
        status: "sent",
        to: recipient,
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
