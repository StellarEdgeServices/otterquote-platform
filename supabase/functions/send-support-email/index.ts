/**
 * OtterQuote Edge Function: send-support-email
 * Receives contractor support form submissions and forwards them to the
 * OtterQuote support inbox via Mailgun.
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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
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
      // Direct email to contractor (e.g., welcome email)
      emailSubject = subject || "Welcome to OtterQuote";
      emailBody = message;
      from = `OtterQuote <notifications@${MAILGUN_DOMAIN}>`;
    } else {
      // Support form email to admin
      emailSubject = subject
        ? `[Contractor Support] ${subject}`
        : `[Contractor Support] Message from ${from_name}`;

      emailBody = `Contractor Support Request
===========================
From:    ${from_name}
Email:   ${from_email}
Subject: ${subject || "(none)"}

Message:
${message}

---
Sent via OtterQuote Contractor Portal contact form.
Reply directly to this email to respond to the contractor.`;

      from = `OtterQuote Support <noreply@${MAILGUN_DOMAIN}>`;
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
