// ============================================================
// Supabase Edge Function: notify-feature-request
//
// Triggered by a Database Webhook on INSERT to feature_requests.
// Sends an email to Dustin via Mailgun whenever a contractor
// submits a feature request.
//
// Required secrets (already set in Supabase Dashboard):
//   MAILGUN_API_KEY
//   MAILGUN_DOMAIN
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { featureRequestEmailText, featureRequestEmailHtml } from "./templates.ts"; // gh-1824: email bodies moved to templates.ts (testable, no serve() import)

// CORS tightened (Session 254): origin-allowlisted instead of wildcard.
// NOTE: This endpoint is invoked by a Supabase Database Webhook, not a browser,
// so CORS is primarily defense-in-depth in case it's ever called from the web.
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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
    const MAILGUN_DOMAIN  = Deno.env.get("MAILGUN_DOMAIN");

    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      throw new Error("Mailgun credentials not configured. Set MAILGUN_API_KEY and MAILGUN_DOMAIN in Supabase secrets.");
    }

    // Supabase Database Webhook sends the row as { type, table, record, old_record }
    const payload = await req.json();
    const record = payload.record ?? payload; // graceful fallback

    const contractorName  = record.contractor_name  ?? "Unknown Contractor";
    const contractorEmail = record.contractor_email ?? "Unknown Email";
    const requestText     = record.request_text     ?? "(no text)";
    const createdAt       = record.created_at
      ? new Date(record.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" })
      : new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });

    // Plain-text body
    const textBody = featureRequestEmailText(contractorName, contractorEmail, requestText, createdAt);

    // HTML body
    const htmlBody = featureRequestEmailHtml(contractorName, contractorEmail, requestText, createdAt);

    // Send via Mailgun
    const fromAddress = `OtterQuote <notifications@${MAILGUN_DOMAIN}>`;
    const basicAuth   = btoa(`api:${MAILGUN_API_KEY}`);

    const formData = new FormData();
    formData.append("from",    fromAddress);
    formData.append("to",      "dustinstohler1@gmail.com");
    formData.append("subject", `🦦 Feature Request — ${contractorName}`);
    formData.append("text",    textBody);
    formData.append("html",    htmlBody);

    const mgRes = await fetch(
      `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
      {
        method:  "POST",
        headers: { Authorization: `Basic ${basicAuth}` },
        body:    formData,
      }
    );

    if (!mgRes.ok) {
      const errText = await mgRes.text();
      throw new Error(`Mailgun error ${mgRes.status}: ${errText}`);
    }

    const mgData = await mgRes.json();
    console.log("notify-feature-request: email sent, Mailgun ID:", mgData.id);

    return new Response(
      JSON.stringify({ success: true, mailgun_id: mgData.id }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("notify-feature-request error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
