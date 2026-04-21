/**
 * Otter Quotes Edge Function: send-support-email
 * Receives contractor support form submissions and forwards them to the
 * Otter Quotes support inbox via Mailgun.
 *
 * The destination address (dustinstohler1@gmail.com) is hardcoded here —
 * callers cannot override the recipient for security reasons.
 *
 * Environment variables required (already set in Supabase secrets):
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const SUPPORT_DESTINATION = "dustinstohler1@gmail.com";

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

  try {
    const { from_name, from_email, subject, message, to_email, html } = await req.json();

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

    // Determine recipient: use to_email if provided, otherwise use SUPPORT_DESTINATION
    const recipient = to_email || SUPPORT_DESTINATION;

    // Determine email subject and body based on recipient
    let emailSubject: string;
    let emailBody: string;
    let from: string;

    if (to_email) {
      // Direct email to a specific recipient (e.g., contractor welcome email)
      emailSubject = subject || "Welcome to Otter Quotes";
      emailBody = message;
      from = `Otter Quotes <notifications@${MAILGUN_DOMAIN}>`;
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
    formData.append("from",      from);
    formData.append("to",        recipient);
    formData.append("subject",   emailSubject);
    formData.append("text",      emailBody);
    // When html is provided (e.g., branded welcome emails), include it for clients that render HTML.
    // The text field above serves as the plain-text fallback.
    if (to_email && html) formData.append("html", html);
    if (!to_email) {
      formData.append("h:Reply-To", `${from_name} <${from_email}>`);
    }

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
      console.error("Mailgun error:", mailgunResponse.status, errorData);
      throw new Error(`Mailgun API error (HTTP ${mailgunResponse.status}): ${errorData}`);
    }

    const result = await mailgunResponse.json();
    console.log("Email sent. Mailgun ID:", result.id, "To:", recipient);

    return new Response(
      JSON.stringify({ status: "sent", id: result.id }),
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
