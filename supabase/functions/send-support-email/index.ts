/**
 * Otter Quotes Edge Function: send-support-email
 * v2 — D-195: inserts support_tickets record on inbound support form submissions.
 *
 * Receives contractor support form submissions and forwards them to the
 * Otter Quotes support inbox via Mailgun.
 *
 * The destination address (dustinstohler1@gmail.com) is hardcoded here —
 * callers cannot override the recipient for security reasons.
 *
 * Environment variables required (already set in Supabase secrets):
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *   SUPABASE_URL             (auto-injected by Supabase runtime)
 *   SUPABASE_SERVICE_ROLE_KEY (auto-injected by Supabase runtime)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPPORT_DESTINATION = "dustinstohler1@gmail.com";
const MAILGUN_TIMEOUT_MS  = 10_000; // 10s — defensive; Mailgun can be slow on cold calls

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

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Health check ping — returns immediately without doing real work.
  // Called by platform-health-check every 15 minutes.
  try {
    const bodyPeek = await req.clone().json().catch(() => ({}));
    if (bodyPeek?.health_check === true) {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }
  } catch { /* no-op */ }

  try {
    const {
      from_name,
      from_email,
      subject,
      message,
      to_email,
      html,
      user_id, // optional — passed when a logged-in user submits the support form
    } = await req.json();

    // Validate required fields
    if (!from_name || !from_email || !message) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: from_name, from_email, message" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
    const MAILGUN_DOMAIN  = Deno.env.get("MAILGUN_DOMAIN");

    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      throw new Error("Mailgun credentials not configured.");
    }

    // Support form submissions (no to_email) → route to admin inbox + insert ticket
    // Direct emails (to_email provided, e.g. welcome emails) → bypass ticket insert
    const isSupportForm = !to_email;
    const recipient     = to_email || SUPPORT_DESTINATION;

    let emailSubject: string;
    let emailBody: string;
    let from: string;

    if (!isSupportForm) {
      // Direct email to a specific recipient (e.g., contractor welcome email)
      emailSubject = subject || "Welcome to Otter Quotes";
      emailBody    = message;
      from         = `Otter Quotes <notifications@${MAILGUN_DOMAIN}>`;
    } else {
      // Support form email to admin
      emailSubject = subject
        ? `[Otter Quotes Support] ${subject}`
        : `[Otter Quotes Support] Message from ${from_name}`;

      emailBody = `Otter Quotes Support Request
===========================
From:    ${from_name}
Email:   ${from_email}
Subject: ${subject || "(none)"}

Message:
${message}

---
Sent via Otter Quotes support form.
Reply directly to this email to respond.`;

      from = `Otter Quotes Support <noreply@${MAILGUN_DOMAIN}>`;
    }

    const formData = new URLSearchParams();
    formData.append("from",    from);
    formData.append("to",      recipient);
    formData.append("subject", emailSubject);
    formData.append("text",    emailBody);
    // HTML only applies to direct emails (e.g., branded welcome emails).
    // Plain-text above is the fallback for all clients.
    if (!isSupportForm && html) formData.append("html", html);
    if (isSupportForm) {
      formData.append("h:Reply-To", `${from_name} <${from_email}>`);
    }

    // ── Mailgun call with 10-second AbortController timeout ──────────────────
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), MAILGUN_TIMEOUT_MS);

    let mailgunResult: { id: string };
    try {
      const mailgunResponse = await fetch(
        `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${btoa(`api:${MAILGUN_API_KEY}`)}`,
          },
          body: formData,
          signal: controller.signal,
        }
      );
      clearTimeout(timeoutId);

      if (!mailgunResponse.ok) {
        const errorData = await mailgunResponse.text();
        console.error("Mailgun error:", mailgunResponse.status, errorData);
        throw new Error(`Mailgun API error (HTTP ${mailgunResponse.status}): ${errorData}`);
      }
      mailgunResult = await mailgunResponse.json();
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") {
        throw new Error("Mailgun request timed out after 10 seconds.");
      }
      throw err;
    }

    console.log("Email sent. Mailgun ID:", mailgunResult.id, "To:", recipient);

    // ── D-195: Insert support_ticket record for inbound support form submissions ──
    // Non-blocking: email was already sent; a DB failure here must not fail the response.
    if (isSupportForm) {
      try {
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );
        const { error: insertError } = await supabase
          .from("support_tickets")
          .insert({
            source:     "form",
            from_name,
            from_email,
            subject:    subject || null,
            body:       message,
            user_id:    user_id || null,
            status:     "open",
            priority:   "normal",
          });
        if (insertError) {
          console.error("D-195: Failed to insert support_ticket:", insertError.message);
        } else {
          console.log("D-195: support_ticket inserted for", from_email);
        }
      } catch (dbErr) {
        console.error("D-195: support_ticket insert exception:", dbErr);
      }
    }

    return new Response(
      JSON.stringify({ status: "sent", id: mailgunResult.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("send-support-email error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
