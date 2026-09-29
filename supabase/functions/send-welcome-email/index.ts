/**
 * OtterQuote Edge Function: send-welcome-email
 *
 * D-220 Phase 16 Unit 1b (Option A): server-side contractor welcome email.
 *
 * Replaces the former browser → send-support-email "direct send" path, which
 * was an unauthenticated open relay (arbitrary recipient + arbitrary HTML from
 * our Mailgun domain). The welcome template now lives here and is sent only to
 * the contractor's own server-derived address after a verified-JWT ownership
 * check.
 *
 * Auth: verify_jwt = true (config.toml). The handler ALSO re-validates the
 * Bearer token via auth.getUser and requires the caller to own the contractor
 * record (contractor.user_id === user.id) — defense in depth + ownership gate.
 *
 * Input:  { contractor_id }
 * Output: { status: "sent", id } | { error }
 *
 * Environment variables (already set in Supabase secrets / injected by runtime):
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *   SUPABASE_URL              (auto-injected by Supabase runtime)
 *   SUPABASE_SERVICE_ROLE_KEY (auto-injected by Supabase runtime)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { buildWelcomeHtml, buildWelcomeText } from "./templates.ts"; // gh-1824: footer moved to templates.ts (testable, no serve() import)

const MAILGUN_TIMEOUT_MS = 10_000; // 10s — defensive; Mailgun can be slow on cold calls

// CORS — mirrors create-hubspot-contact's origin allow-list.
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, corsHeaders);
  }

  // ── Auth: require a verified Bearer JWT (also enforced at the gateway) ──────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Unauthorized" }, 401, corsHeaders);
  }
  const token = authHeader.slice(7);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const sb = createClient(supabaseUrl, serviceRoleKey);

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) {
    return json({ error: "Unauthorized" }, 401, corsHeaders);
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  let contractor_id: string;
  try {
    const body = await req.json();
    contractor_id = body.contractor_id;
  } catch {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders);
  }
  if (!contractor_id) {
    return json({ error: "Missing required field: contractor_id" }, 400, corsHeaders);
  }

  // ── Load contractor (service-role; recipient is server-derived) ─────────────
  const { data: contractor, error: contractorErr } = await sb
    .from("contractors")
    .select("id, user_id, email, company_name, is_test")
    .eq("id", contractor_id)
    .single();

  if (contractorErr || !contractor) {
    return json({ error: "Contractor not found" }, 404, corsHeaders);
  }

  // Ownership gate: the caller must own this contractor record.
  if (contractor.user_id !== user.id) {
    return json({ error: "Forbidden" }, 403, corsHeaders);
  }

  // Recipient is derived server-side — never accepted from the request body.
  const recipient = contractor.email || user.email;
  if (!recipient) {
    return json({ error: "No recipient address on file" }, 422, corsHeaders);
  }

  const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
  const MAILGUN_DOMAIN = Deno.env.get("MAILGUN_DOMAIN");
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    console.error("send-welcome-email: Mailgun credentials not configured.");
    return json({ error: "Mailgun credentials not configured." }, 500, corsHeaders);
  }

  // ── Build the welcome email server-side (ported verbatim from js/auth.js) ───
  const greeting = contractor.company_name || "there";
  const settingsUrl = "https://otterquote.com/contractor-settings.html";
  const subject = "Welcome to Otter Quotes — Your Application Is In Review";

  const welcomeMessage = buildWelcomeText(greeting, settingsUrl);
  const welcomeHtml = buildWelcomeHtml(greeting, settingsUrl);

  // ── Send via Mailgun (10s AbortController timeout) ──────────────────────────
  const formData = new URLSearchParams();
  formData.append("from", `Otter Quotes <notifications@${MAILGUN_DOMAIN}>`);
  formData.append("to", recipient);
  formData.append("subject", subject);
  formData.append("text", welcomeMessage);
  formData.append("html", welcomeHtml);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MAILGUN_TIMEOUT_MS);

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
      console.error("send-welcome-email Mailgun error:", mailgunResponse.status, errorData);
      return json(
        { error: `Mailgun API error (HTTP ${mailgunResponse.status})` },
        502,
        corsHeaders
      );
    }
    mailgunResult = await mailgunResponse.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      console.error("send-welcome-email: Mailgun request timed out after 10 seconds.");
      return json({ error: "Mailgun request timed out after 10 seconds." }, 504, corsHeaders);
    }
    console.error("send-welcome-email: Mailgun request failed:", err);
    return json({ error: "Failed to send welcome email" }, 502, corsHeaders);
  }

  console.log("send-welcome-email sent. Mailgun ID:", mailgunResult.id, "To:", recipient);

  // ── Activity log (non-fatal: the email was already sent) ────────────────────
  try {
    const { error: logError } = await sb.from("activity_log").insert({
      user_id: contractor.user_id,
      event_type: "welcome_email_sent",
      title: `Welcome email sent to ${recipient}`,
      is_test: contractor.is_test ?? false,
      metadata: {
        contractor_id: contractor.id,
        message_id: mailgunResult.id,
      },
    });
    if (logError) {
      console.error("send-welcome-email: activity_log insert failed (non-fatal):", logError.message);
    }
  } catch (logErr) {
    console.error("send-welcome-email: activity_log insert exception (non-fatal):", logErr);
  }

  return json({ status: "sent", id: mailgunResult.id }, 200, corsHeaders);
});
